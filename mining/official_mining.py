"""Run the upstream ProgramBench agent and prepare a normal issue draft."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import uuid
from urllib.parse import urlsplit

import yaml


ROOT = Path(__file__).resolve().parent
REPORT = "requirements-mining.md"
MAX_REPORT_BYTES = 30000
MAX_TRAJECTORY_BYTES = 5 * 1024 * 1024
MAX_ISSUE_BODY_BYTES = 18 * 1024


def public_source_origin(key, value):
    if key != 'MINING_SOURCE_CREDENTIAL_ORIGIN':
        return False
    try:
        url = urlsplit(value)
        return bool(url.scheme in ('http', 'https') and url.hostname and not url.username and not url.password
                    and url.path in ('', '/') and not url.query and not url.fragment)
    except ValueError:
        return False


def execution_label(env):
    label = env.get("MINING_EXECUTION_LABEL") or f"devstar-mining-run={uuid.uuid4().hex}"
    if not re.fullmatch(r"devstar-mining-run=[0-9a-f]{32}", label):
        raise ValueError("Invalid mining execution label")
    return label


def direct_reference_command(command, executable):
    """Identify a simple direct invocation, not a substring in an echo or pipeline."""
    command = re.sub(r"^\s*cd[ \t]+/workspace[ \t]+&&[ \t]+", "", command, count=1)
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars="|&;<>()")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return False
    allowed = {executable}
    if executable == "executable":
        allowed = {"./executable", "/workspace/executable"}
    return bool(tokens and tokens[0] in allowed and
                not any(re.fullmatch(r"[|&;<>()]+", token) for token in tokens) and
                not any("$(" in token or "`" in token for token in tokens))


def confirmed_reference_result(command, code, output, executable):
    if not isinstance(code, int) or code in (126, 127):
        return False
    if direct_reference_command(command, executable):
        return True
    # Accept only a direct invocation followed by an unmodified exit-code echo.
    match = re.fullmatch(r'(.+);\s*echo\s+"EXIT[=:]\$\?"\s*', command)
    if not match or not direct_reference_command(match[1], executable) or code != 0:
        return False
    recorded = re.search(r'(?:^|\n)EXIT[=:]([0-9]{1,3})\s*(?:</output>)?\s*$', output)
    return bool(recorded and 0 <= int(recorded[1]) <= 255 and int(recorded[1]) not in (126, 127))


def labeled_containers(label, env):
    execution_label({"MINING_EXECUTION_LABEL": label})
    result = subprocess.run(["docker", "ps", "--quiet", "--filter", f"label={label}"],
                            env=env, check=True, capture_output=True, text=True, timeout=30)
    containers = result.stdout.split()
    if not all(re.fullmatch(r"[0-9a-f]{12,64}", value) for value in containers):
        raise ValueError("无法安全识别本次运行容器")
    return containers


def actual_image(container, expected_reference, env):
    result = subprocess.run(["docker", "inspect", "--format", "{{.Image}} {{.Config.Image}}", container],
                            env=env, check=True, capture_output=True, text=True, timeout=30)
    parts = result.stdout.strip().split()
    if len(parts) != 2 or not re.fullmatch(r"sha256:[a-f0-9]{64}", parts[0]) or parts[1] != expected_reference:
        raise ValueError("实际运行镜像的身份无法验证")
    return parts[0]


def preserve_trajectory(instance, output, env):
    source = output / instance / f"{instance}.traj.json"
    if not source.is_file() or source.is_symlink() or source.stat().st_size > MAX_TRAJECTORY_BYTES:
        raise ValueError("完整运行轨迹不存在或超过大小限制")
    data = source.read_bytes()
    decoded = json.dumps(json.loads(data), ensure_ascii=False).encode("utf-8")
    for key, value in env.items():
        if re.search(r"TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTH", key, re.I) and not public_source_origin(key, value):
            secret = value.strip() if isinstance(value, str) else ""
            if len(secret) >= 8 and (secret.encode("utf-8") in data or secret.encode("utf-8") in decoded):
                raise ValueError("运行轨迹包含敏感环境值，拒绝导出")
    with (output / "official-trajectory.json").open("xb") as target:
        target.write(data)


def issue_from_result(instance, directory, *, executable="executable", source_label="ProgramBench"):
    folder = Path(directory) / instance
    trajectory = json.loads((folder / f"{instance}.traj.json").read_text(encoding="utf-8"))
    info = trajectory.get("info", {})
    if trajectory.get("instance_id") != instance or info.get("exit_status") != "Submitted":
        raise ValueError("官方运行器未成功完成，不能生成工单")
    if info.get("submission_copy_error"):
        raise ValueError("工作区归档失败，不能生成工单")
    observations = []
    pending = []
    for message in trajectory.get("messages", []):
        if message.get("role") == "assistant":
            actions = message.get("extra", {}).get("actions", [])
            pending = [action for action in actions if isinstance(action, dict) and isinstance(action.get("command"), str)]
        elif pending and message.get("role") in ("user", "tool") and "returncode" in message.get("extra", {}):
            call_id = message.get("tool_call_id")
            index = next((i for i, action in enumerate(pending) if action.get("tool_call_id") == call_id), None)
            if index is None:
                continue
            action = pending.pop(index)
            if not message["extra"].get("exception_info"):
                observations.append((action["command"], message["extra"]["returncode"], message.get("content", "")))
    if not any(confirmed_reference_result(command, code, output, executable)
               for command, code, output in observations):
        raise ValueError("运行轨迹没有可确认的直接程序调用，不能生成工单")
    with tarfile.open(folder / "submission.tar.gz", "r:gz") as archive:
        matches = [member for member in archive if member.name in (REPORT, "./" + REPORT)]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > MAX_REPORT_BYTES:
            raise ValueError("需求报告缺失、重复或过大，不能生成工单")
        report_file = archive.extractfile(matches[0])
        if report_file is None:
            raise ValueError("无法读取需求报告")
        report = report_file.read(MAX_REPORT_BYTES + 1).decode("utf-8").strip()
    if not report or len(report.encode("utf-8")) > MAX_REPORT_BYTES:
        raise ValueError("需求报告为空或过大")
    introduction = (
        "请依据以下文档和黑盒观察，对照仓库已有规格评审需求，整理候选规格并提交评审 PR；未验证的边界保留为开放问题。\n\n"
        f"参考程序：{source_label} `{instance}`。以下是模型对本次有限探索的归纳，"
        "不是官方标准答案，也不代表全部需求；未观察到的行为应保留为待验证。\n\n"
        f"## 候选需求与边界\n\n{report}\n\n"
    )
    evidence_header = (
        "<details>\n<summary>查看运行依据（命令与真实返回）</summary>\n\n"
        "以下为运行器记录的部分命令与返回内容。标准输出与错误输出已合并；"
        "退出码属于整条命令，使用管道或组合命令时不一定是程序自身的退出码。"
        "完整轨迹保存在本次运行产物中，未列出的记录不代表未执行。\n\n"
    )
    ending = "\n\n</details>"
    # Leave room for the caller's image identity and the platform's 20 KiB input gate.
    if len((introduction + evidence_header + ending).encode("utf-8")) > MAX_ISSUE_BODY_BYTES:
        raise ValueError("候选报告过长，无法在平台分析上限内完整发布；请缩小探索范围，完整报告与轨迹已保留")
    evidence = []
    for command, code, output in observations:
        if not confirmed_reference_result(command, code, output, executable) or REPORT in command:
            continue
        # Fences are made longer than any fence in untrusted command/output.
        visible = re.search(r"<output>([\s\S]*?)</output>", output)
        text = f"$ {command}\nRecorded command exit: {code}\n{visible[1] if visible else output}"
        longest = max((len(match) for match in re.findall(r"`+", text)), default=0)
        fence = "`" * max(3, longest + 1)
        block = f"{fence}text\n{text[:4000]}\n{fence}"
        candidate = introduction + evidence_header + "\n\n".join([*evidence, block]) + ending
        if len(candidate.encode("utf-8")) <= MAX_ISSUE_BODY_BYTES:
            evidence.append(block)
    body = introduction + evidence_header + "\n\n".join(evidence) + ending
    return {"title": f"整理 {instance} 的候选需求规格", "body": body}


def prepare_issue(instance, output, reference, image_id, runner_version, *, restored=False):
    issue = issue_from_result(instance, output)
    preserve_trajectory(instance, output, os.environ)
    provenance = {"instance": instance, "image_reference": reference, "image_id": image_id,
                  "mini_swe_agent_version": runner_version, "restored_from_completed_trajectory": restored}
    (output / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    issue["body"] += f"\n\n实际运行镜像 ID：`{image_id}`。\n"
    (output / "issue.json").write_text(json.dumps(issue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output / "issue.json"


def restore_completed(instance, output, source, reference, image_id, runner_version):
    """Recover a saved official submission after import failed; do not run inference."""
    folder = Path(source)
    expected = (f"{instance}.traj.json", "submission.tar.gz")
    if not folder.is_absolute() or folder.name != instance or not all(
            (folder / name).is_file() and not (folder / name).is_symlink() and
            (folder / name).stat().st_size <= MAX_TRAJECTORY_BYTES for name in expected):
        raise ValueError("恢复材料不是受控官方运行产物")
    target = output / instance
    target.mkdir()
    for name in expected:
        shutil.copyfile(folder / name, target / name)
    return prepare_issue(instance, output, reference, image_id, runner_version, restored=True)


def run(instance, output, model):
    catalog = json.loads((ROOT / "tasks" / "official-catalog.json").read_text(encoding="utf-8-sig"))
    if not any(item.get("instance_id") == instance for item in catalog.get("tasks", [])):
        raise ValueError("不在官方任务清单中")
    if not re.fullmatch(r"[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.[0-9a-f]{7,40}", instance):
        raise ValueError("官方实例标识无效")
    if not model or not os.environ.get("OPENJIUWEN_API_KEY") or not os.environ.get("OPENJIUWEN_API_BASE"):
        raise ValueError("缺少模型地址、模型名称或密钥")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = str(output / "agent-config")
    from minisweagent import __version__, package_dir
    if __version__ != "2.4.6":
        raise ValueError("请安装 mini-swe-agent 2.4.6")
    official_config = package_dir / "config" / "benchmarks" / "programbench.yaml"
    config = yaml.safe_load((ROOT / "integrations" / "devstar" / "programbench-mining.yaml").read_text(encoding="utf-8"))
    scope = os.environ.get("MINING_SCOPE", "").strip()
    if len(scope) > 4000:
        raise ValueError("探索范围过长")
    if scope:
        config["agent"]["instance_template"] += "\nRequested exploration scope: " + scope + "\n"
    label = execution_label(os.environ)
    config["environment"]["run_args"].extend(["--label", label])
    lab_label = os.environ.get("MINING_OFFICIAL_LAB_LABEL", "")
    if lab_label:
        if not re.fullmatch(r"devstar-local-official=[a-f0-9]{16}", lab_label):
            raise ValueError("Invalid local lab execution label")
        config["environment"]["run_args"].extend(["--label", lab_label])
    reference = f"programbench/{instance.replace('__', '_1776_')}:task_cleanroom_v6"
    pinned_image = os.environ.get("MINING_OFFICIAL_IMAGE_ID", "")
    if pinned_image:
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", pinned_image):
            raise ValueError("参考镜像必须绑定完整 ID")
        preflight_image = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", reference],
                                                 text=True, timeout=30).strip()
        if preflight_image != pinned_image:
            raise ValueError("官方任务标签与锁定镜像不一致，未调用模型")
        config["environment"]["run_args"].extend(["--pull", "never"])
    restored_source = os.environ.get("MINING_OFFICIAL_RECOVERY_SOURCE", "")
    if restored_source:
        if not pinned_image:
            raise ValueError("恢复必须绑定原运行的镜像 ID")
        return restore_completed(instance, output, restored_source, reference, pinned_image, __version__)
    config_file = output / "mining-config.yaml"
    config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    env = os.environ.copy()
    env["OPENAI_API_KEY"] = env.pop("OPENJIUWEN_API_KEY")
    env["OPENAI_API_BASE"] = env.pop("OPENJIUWEN_API_BASE")
    env.pop("DEVSTAR_TOKEN", None)
    env.pop("MINING_ISSUE_TOKEN", None)
    env["MSWEA_GLOBAL_CALL_LIMIT"] = "12"
    env["MSWEA_COST_TRACKING"] = "ignore_errors"
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    env["MSWEA_GLOBAL_CONFIG_DIR"] = str(output / "agent-config")
    command = [sys.executable, "-m", "minisweagent.run.benchmarks.programbench", "--filter",
               "^" + re.escape(instance) + "$", "--workers", "1", "--output", str(output),
               "--model", "openai/" + model.removeprefix("openai/"), "-c", str(official_config), "-c", str(config_file)]
    try:
        subprocess.run(command, env=env, check=True, timeout=1200)
        containers = labeled_containers(label, env)
        if len(containers) != 1:
            raise ValueError("无法确定本次运行的唯一参考程序容器")
        image_id = actual_image(containers[0], reference, env)
        if pinned_image and image_id != pinned_image:
            raise ValueError("实际运行镜像没有匹配锁定 ID，禁止发布")
    finally:
        containers = labeled_containers(label, env)
        if containers:
            subprocess.run(["docker", "stop", *containers], env=env, check=True, timeout=60)
    return prepare_issue(instance, output, reference, image_id, __version__)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("instance")
    parser.add_argument("output")
    args = parser.parse_args()
    print(run(args.instance, args.output, os.environ.get("OPENJIUWEN_MODEL", "")))
