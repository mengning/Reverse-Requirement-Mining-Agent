import {validateSynthesis,renderSynthesis} from './synthesize.mjs';
import {documentContainsQuote} from './quote-match.mjs';

const ISSUE_TITLE = "整理程序已观察行为的候选需求规格";
const MAX_BODY_BYTES = 50000;
const TARGET_DOCUMENT = "由规格 Agent 对照仓库确定";

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null || typeof value === "number" ||
      typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeNewlines(value) {
  return textOf(value).replace(/\r\n?/g, "\n");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline fields are untrusted. Collapse line breaks so they cannot start a
// heading or a fenced block, then escape HTML so they cannot close <details>.
function inline(value) {
  return escapeHtml(
    normalizeNewlines(value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// Documentation is quoted in a fence. Angle brackets are escaped as an extra
// guard for renderers that treat details content loosely.
function fencedDocumentText(value) {
  return normalizeNewlines(value).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Choose a fence longer than every backtick run in the content. A payload
// therefore cannot terminate the fence early.
function fence(content, language) {
  const text = normalizeNewlines(content);
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const marker = "`".repeat(Math.max(3, longest + 1));
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return `${marker}${language}\n${body}\n${marker}`;
}

// JSON.stringify escapes line breaks inside string values. Escaping angle
// brackets as JSON escapes keeps the decoded values exact while preventing a
// value such as </details> from appearing literally in the issue body.
function safeJson(value) {
  const json = JSON.stringify(value, null, 2) ?? "null";
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

// Deterministically cut UTF-8 text at a byte budget without splitting a code
// point, so repeated renders of the same input always produce the same body.
function truncateUtf8(text, maxBytes) {
  const value = textOf(text);
  if (byteLength(value) <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (byteLength(output) + byteLength(character) > maxBytes) break;
    output += character;
  }
  return output;
}

const TRUNCATION_NOTE = (originalBytes) =>
  `……【截断提示：原文 ${originalBytes} 字节，受工单正文长度上限限制，此处仅保留部分内容；完整原文以任务原始材料为准】`;

// Render a body whose only unbounded part is folded documentation. When the
// full documents would push the body over the limit, shrink them
// proportionally (largest documents lose the most) and mark every cut, so
// publication fails only when even documentation-free content cannot fit.
export function renderWithinLimit(documents, maxBytes, build) {
  const texts = toArray(documents).map((document) => textOf(document?.text));
  let body = build(texts);
  if (byteLength(body) <= maxBytes) return {body, truncated: []};
  const sizes = texts.map((text) => byteLength(text));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) {
    throw new Error(`issue body exceeds ${maxBytes} UTF-8 bytes even without documentation`);
  }
  // Scaffolding size with empty documents, plus a conservative margin for the
  // truncation notes and fence growth, leaves the budget for document text.
  let budget = maxBytes - byteLength(build(texts.map(() => ""))) - 160 * texts.length - 256;
  if (budget <= 0) {
    throw new Error(`issue body exceeds ${maxBytes} UTF-8 bytes even without documentation`);
  }
  for (let round = 0; round < 8; round += 1) {
    const kept = texts.map((text, index) =>
      Math.min(sizes[index], Math.floor((budget * sizes[index]) / total)));
    body = build(texts.map((text, index) => {
      if (kept[index] >= sizes[index]) return text;
      return `${truncateUtf8(text, kept[index])}${TRUNCATION_NOTE(sizes[index])}`;
    }));
    if (byteLength(body) <= maxBytes) {
      return {
        body,
        truncated: texts.map((text, index) => kept[index] >= sizes[index] ? null : ({
          original: sizes[index],
          kept: byteLength(truncateUtf8(text, kept[index])),
        })),
      };
    }
    budget = Math.floor(budget * 0.85);
    if (budget <= 0) break;
  }
  throw new Error(`issue body exceeds ${maxBytes} UTF-8 bytes; documentation could not be reduced further`);
}

export function sampleCell(value) {
  const full = JSON.stringify(value) ?? 'null';
  const characters = Array.from(full);
  const shortened = characters.length > 90;
  const visible = shortened ? characters.slice(0, 90).join('') + '…' : full;
  return `<code>${escapeHtml(visible).replace(/\|/g, '&#124;').replace(/`/g, '&#96;')}</code>${shortened ? '（截短，完整值见原始记录）' : ''}`;
}

// Render one exact observation record. stdout/stderr/stdin/file_text (and
// repeat_result's stdout/stderr) are clipped to fieldCap characters with
// excerpt metadata; raw_bytes never enters the issue body (base64 stays in
// the local evidence files).
function observationValue(observation, fieldCap) {
  const fields = {};
  const clip = (name, original) => {
    const value = textOf(original);
    if (fieldCap !== Infinity && typeof original === 'string' && original.length > fieldCap) {
      fields[name] = {original_length: original.length, kept_length: fieldCap};
      return original.slice(0, fieldCap);
    }
    return value;
  };
  const stdout = clip('stdout', observation?.stdout);
  const stderr = clip('stderr', observation?.stderr);
  const stdin = clip('stdin', observation?.stdin);
  const fileText = clip('file_text', observation?.file_text);
  const repeated = observation?.repeat_result;
  const repeatedStdout = clip('repeat_result.stdout', repeated?.stdout);
  const repeatedStderr = clip('repeat_result.stderr', repeated?.stderr);
  return {
    id: textOf(observation?.id),
    argv: toArray(observation?.argv).map(textOf),
    ...(observation?.file_text!==undefined?{file_text:fileText}:{}),
    ...(repeated?{repeat_result:{
      stdout: repeatedStdout,
      stderr: repeatedStderr,
      exit_code: repeated?.exit_code ?? null,
    }}:{}),
    ...(observation?.unsupported?{unsupported:true}:{}),
    stdin, stdout, stderr,
    exit_code: observation?.exit_code ?? null,
    sha256: textOf(observation?.sha256),
    ...(Object.keys(fields).length?{excerpt_fields:fields}:{}),
  };
}

function assertKnownReferences(features, documentIds, observationIds) {
  for (const feature of features) {
    const featureId = textOf(feature?.id);
    for (const reference of toArray(feature?.document_ids)) {
      const id = textOf(reference);
      if (!documentIds.has(id)) {
        throw new Error(
          `missing referenced evidence ID: unknown document ${JSON.stringify(id)} in feature ${JSON.stringify(featureId)}`,
        );
      }
    }
    for (const reference of toArray(feature?.observation_ids)) {
      const id = textOf(reference);
      if (!observationIds.has(id)) {
        throw new Error(
          `missing referenced evidence ID: unknown observation ${JSON.stringify(id)} in feature ${JSON.stringify(featureId)}`,
        );
      }
    }
  }
}

export function renderRequirementIssue(input) {
  const data = input && typeof input === "object" ? input : {};
  const documents = toArray(data.documents);
  const observations = toArray(data.observations);
  const features = toArray(data.features);
  const unexplored = toArray(data.unexplored)
    .map(textOf)
    .filter((item) => item.trim() !== "");

  const documentIds = new Set(documents.map((document) => textOf(document?.id)));
  const observationIds = new Set(observations.map((observation) => textOf(observation?.id)));
  assertKnownReferences(features, documentIds, observationIds);
  for (const feature of features) {
    if (feature.document_quote !== undefined && (typeof feature.document_quote !== 'string' || !feature.document_quote.trim() ||
        !documents.some(d => toArray(feature.document_ids).includes(d.id) && typeof d.text === 'string' && documentContainsQuote(d.text, feature.document_quote)))) {
      throw new Error('Feature quote does not match its referenced document');
    }
  }

  const discovered = data.feature_origin === 'model-discovery';

  // The only parts allowed to shrink near the byte limit are the folded
  // documentation and per-field observation excerpts; everything else must fit
  // as rendered.
  const buildBody = (docTexts, obsCap) => {
    const docs = documents.map((document, index) => ({...document, text: docTexts[index] ?? ""}));
    const lines = [];
    lines.push("## 目标", "");
    lines.push(
      `为任务 ${inline(input.task_id)} 整理一份候选规格。路径${TARGET_DOCUMENT}；说明已有证据支持的行为与未验证边界。只整理需求，不修改实现代码。`,
      "",
    );
    lines.push('<details>', '<summary>规格 PR 的交付范围</summary>', '');
    lines.push("- 不修改实现代码、测试、构建脚本、依赖或运行时配置；");
    lines.push("- 保留与本次需求无关的既有规格文件及条款原文，不做删除、重命名或改写；");
    lines.push("- 请委托 Spec Agent 核对已有规格；需要新增或更新时，在同一次已授权的委托中提交仅包含规格文档变更的评审 PR；");
    lines.push("- 不合并任何变更，也不直接推送默认分支；");
    lines.push("- 本工单不预写 Spec 条款，也不提供预期官方答案；请依据下列公开证据独立整理。");
    lines.push('', '</details>', '');
    lines.push("> 本工单不声称覆盖程序的全部行为；未列出的边界仍需验证。");
    lines.push("");

    lines.push("## 范围", "");
    lines.push('| 本次研究 | 本次不研究 |', '| --- | --- |',
      `| ${inline(data.scope)} | 超出任务范围或没有执行证据的行为不作为已验证结论 |`, '',
      '**注意：** 下文只是有限样例和候选解释，不代表整个程序的全部需求。', '',
      '<details>', '<summary>查看任务标识与原始范围说明</summary>', '');
    lines.push(`- 任务标识：${inline(data.task_id) || "未提供"}`);
    lines.push(`- 范围说明：${inline(data.scope) || "未提供额外范围说明。"}`);
    lines.push('', '</details>', '');

    if (data.synthesis) {
      const synthesis = validateSynthesis(data.synthesis, data);
      if (synthesis.input_sha256 !== data.synthesis.input_sha256) throw new Error('Synthesis evidence snapshot changed');
      lines.push(renderSynthesis(synthesis), '', '<details>', '<summary>原始探索方向（不是独立功能数量）</summary>', '');
    }
    lines.push(discovered ? "## 文档驱动发现的功能清单" : "## 作者整理的功能清单", "");
    lines.push(
      discovered ? "以下条目由模型根据公开文档提出，经原文引用校验。功能描述仍需复核；有观察编号只表示执行过对应样例，不证明普遍成立；没有观察编号的条目仅有文档依据。未覆盖全部功能与输入。" : "以下条目由作者根据公开证据手工整理，用于组织需求，不是实际观测结果，也不代表完整覆盖。功能是否成立应以“已观察的输入与输出”和“尚未验证的边界”为准。",
      "",
    );
    if (features.length === 0) {
      lines.push("未提供作者整理的功能条目；不能据此认为不存在需求。", "");
    } else {
      for (const feature of features) {
        const documentReferences = toArray(feature?.document_ids)
          .map((reference) => inline(reference))
          .filter(Boolean);
        const observationReferences = toArray(feature?.observation_ids)
          .map((reference) => inline(reference))
          .filter(Boolean);
        lines.push(
          `- 功能 ${inline(feature?.id) || "未命名"}：${inline(feature?.description) || "未提供说明"}（文档证据：${documentReferences.length ? documentReferences.join("、") : "无"}；观察证据：${observationReferences.length ? observationReferences.join("、") : "无"}）`,
        );
        if (feature.document_quote) lines.push(`  文档原文（仅为依据，语义仍待评审）：${inline(feature.document_quote)}`);
      }
      lines.push("");
    }

    if (data.synthesis) lines.push('</details>', '');
    lines.push("## 公开文档证据", "");
    if (docs.length === 0) {
      lines.push("未提供公开文档证据。", "");
    } else {
      lines.push(
        "这是归纳时参考的原始说明书，不是验证结论。需要核对某句话的来源时再展开；文档没有写清楚的地方，不能自行当成确定规则。",
        "",
      );
      for (const document of docs) {
        const id = inline(document?.id) || "未命名文档";
        const sha256 = inline(document?.sha256) || "未提供";
        lines.push("<details>");
        lines.push(`<summary>查看原文：${id}</summary>`, "", `文件校验摘要：${sha256}`, '');
        lines.push(fence(fencedDocumentText(document?.text), "text"), "");
        lines.push("</details>", "");
      }
    }

    lines.push("## 已观察的输入与输出", "");
    if (observations.length === 0) {
      lines.push("未提供已观察的输入与输出。", "");
    } else {
      lines.push(
        `共 ${observations.length} 条观察。下面先展示前 ${Math.min(3, observations.length)} 条，其余记录在后面展开。字符串中的 \\n 表示换行，\`""\` 表示空字符串；这些是实际运行结果，不是模型猜测或官方预期答案。`,
        "",
      );
      if (data.interaction?.profile === 'service-http/v1') {
        lines.push("本次为 HTTP 服务探测：stdin 保存请求 JSON，stdout 保存实际响应状态、所选响应头和响应体；exit_code 是探测器退出状态，不是 HTTP 状态码。", "");
      }
      if (data.interaction?.profile === 'adapter-json/v1') {
        lines.push("本次通过固定适配器操作程序：stdin 保存操作输入，stdout 保存适配器记录；unsupported 表示操作未获支持，不能当成目标行为证据。", "");
      }
      if (data.interaction?.profile === 'cli-text-file/v1') {
        lines.push("本次通过固定临时文本文件操作程序：file_text 是执行器准备的文件内容，stdout/stderr 是程序实际输出。", "");
      }
      if (obsCap !== Infinity && observations.some(observation =>
          ['stdout','stderr','stdin','file_text'].some(field => typeof observation?.[field] === 'string' && observation[field].length > obsCap) ||
          ['stdout','stderr'].some(field => typeof observation?.repeat_result?.[field] === 'string' && observation.repeat_result[field].length > obsCap))) {
        lines.push(`部分超长输出已按确定性规则摘录（stdout/stderr 各保留前 ${obsCap} 字符，original_length 见记录内 excerpt_fields）；base64 原始字节不进工单，完整原文保留在本地报告目录（input.json 与 round-*.json）。`, "");
      }
      for (const [index, observation] of observations.slice(0, 3).entries()) {
        lines.push(`**实测例 ${index + 1}**（${inline(observation.id)}）`, '',
          '| 项目 | 实测内容 |', '| --- | --- |',
          `| 调用参数 | ${sampleCell(toArray(observation.argv))} |`,
          `| 输入文本 | ${sampleCell(observation.stdin)} |`,
          ...(observation.file_text!==undefined?[`| 临时文件内容 | ${sampleCell(observation.file_text)} |`]:[]),
          `| 实际输出 | ${sampleCell(observation.stdout)} |`,
          `| 错误信息 | ${sampleCell(observation.stderr)} |`,
          `| 退出码 | ${sampleCell(observation.exit_code)} |`, '');
      }
      lines.push('<details>', `<summary>查看全部 ${observations.length} 条完整输入输出记录</summary>`, '',
        '以下保留观察记录（超长输出按正文所述规则确定性摘录，完整原文在本地报告目录），便于复核，不把样例推广为通用规则。', '');
      for (const observation of observations) {
        const id = inline(observation?.id) || "未命名观察";
        lines.push("<details>");
        lines.push(`<summary>观察记录 ${id}</summary>`, "");
        lines.push(fence(safeJson(observationValue(observation, obsCap)), "json"), "");
        lines.push("</details>", "");
      }
      lines.push('</details>', '');
    }

    lines.push("## 尚未验证的边界", "");
    if (unexplored.length === 0) {
      lines.push("- 输入未列出明确的未探索项；这只是作者记录的空缺清单，不代表已覆盖全部边界。", "");
    } else {
      lines.push('以下内容没有得到本次探测证明；不表示程序不支持，也不是现在要自动执行的任务。', '');
      if (data.synthesis) lines.push('每组候选需求中的“还需验证”列出该组仍缺失的输入类型、边界或文档解释，不视为已经执行。', '');
      for (const item of [...new Set(unexplored)]) {
        lines.push(`- ${inline(item)}`);
      }
      lines.push("");
    }

    let body = lines.join("\n");
    if (data.synthesis) {
      const groups = data.synthesis.groups;
      const safeText = value => inline(value).replace(/[\\[\]*_`|#!]/g, character => `\\${character}`);
      const questions = [...new Set(groups.map(group => group.missing_checks[0]).filter(Boolean))];
      body = [
        '## 目标', '',
        `把任务 ${inline(input.task_id)} 的已观察行为整理为候选规格，供评审。先对照已有规格，再准备草稿；不修改实现代码或无关规格，创建 PR 需单独授权，不合并、不改默认分支。`, '',
        '## 范围', '',
        inline(input.scope || '仅限提供的公开材料和实测观察。'), '',
        '未探测的功能与输入组合不视为已验证。', '',
        '## 要整理的功能', '',
        '请把以下候选行为写清楚，并给出可检查的场景；未验证的部分单独标注，不直接写成确定规则。', '',
        ...groups.map((group,index)=>`${index+1}. ${safeText(group.title)}`), '',
        '## 待确认问题', '',
        '现有样例不足以证明所有情况。以下问题仍需验证或评审确认：', '',
        ...questions.map(question=>`- ${safeText(question)}`), '',
        `材料依据：公开文档和 ${observations.length} 条实测观察。不是整个程序的完整需求，也不是规格质量已通过。`, '',
        '<details>', '<summary>查看依据：具体行为、输入输出、文档原文与未验证边界</summary>', '',
        body, '', '</details>'
      ].join('\n');
    }
    return body;
  };

  // Tiered deterministic fallback: first try the full-fidelity render (with the
  // existing documentation shrinker); if oversized observations still break the
  // byte limit, shrink per-field excerpts step by step until the body fits.
  // Publication fails only when even the smallest tier cannot fit.
  const OBSERVATION_FIELD_TIERS = [Infinity, 4000, 2000, 1000, 500, 250];
  let lastError;
  for (const obsCap of OBSERVATION_FIELD_TIERS) {
    try {
      const {body} = renderWithinLimit(documents, MAX_BODY_BYTES, docTexts => buildBody(docTexts, obsCap));
      return {title: `${ISSUE_TITLE}（${inline(input.task_id)}）`, body};
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
