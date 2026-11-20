"""One bounded loopback request to a fresh, isolated reference service.

Response bodies are read up to a fixed cap and, when longer than the body
budget, deterministically truncated to their first MAX_BODY_BYTES bytes with
explicit truncation metadata instead of failing the probe. Readiness is
declared by TCP reachability on the loopback port: any HTTP status the service
answers with (including 404/405 health pages) is recorded as real evidence.
"""
import base64
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time

MAX_BODY_BYTES = 16384
BODY_READ_CHUNK = 65536
BODY_READ_CAP = 1024 * 1024


def read_body(response):
    """Read the response body up to BODY_READ_CAP bytes.

    Returns ``(data, read_capped)`` where ``read_capped`` is True only when the
    cap stopped the read before end-of-body. The byte count callers report is
    ``len(data)``: the bytes actually read, which equals the true body size
    unless the 1 MiB cap was hit (then ``body_read_capped`` is set and the
    count is the cap). Identical responses therefore produce identical
    evidence on every run.
    """
    chunks = []
    total = 0
    while True:
        chunk = response.read(min(BODY_READ_CHUNK, BODY_READ_CAP - total))
        if not chunk:
            return b''.join(chunks), False
        chunks.append(chunk)
        total += len(chunk)
        if total >= BODY_READ_CAP:
            extra = response.read(1)
            return b''.join(chunks), bool(extra)


def truncate_at_limit(data):
    """Return ``(truncated_bytes, truncated)`` cut to MAX_BODY_BYTES bytes."""
    if len(data) <= MAX_BODY_BYTES:
        return data, False
    return data[:MAX_BODY_BYTES], True


def utf8_prefix_text(data):
    """Decode ``data`` as UTF-8; tolerate only an incomplete final sequence.

    Returns None when the bytes are genuinely not UTF-8, so callers can fall
    back to the existing non-UTF-8 placeholder instead of inventing content.
    """
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError as error:
        if error.reason == 'unexpected end of data' and error.start >= len(data) - 3:
            try:
                return data[:error.start].decode('utf-8')
            except UnicodeDecodeError:
                return None
        return None


def terminate_process_tree(process):
    """Stop the service and its children; portable enough for unit tests."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except AttributeError:
        process.terminate()
    except ProcessLookupError:
        pass


def kill_process_tree(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except AttributeError:
        process.kill()
    except ProcessLookupError:
        pass


def probe(config, request):
    process = subprocess.Popen(
        [config['executable'], *config['args']],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    connection = None
    try:
        deadline = time.monotonic() + config['startup_seconds']
        while True:
            if process.poll() is not None:
                raise RuntimeError('Reference service exited before accepting a request')
            try:
                with socket.create_connection(('127.0.0.1', config['port']), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Reference service startup timed out') from None
                time.sleep(0.05)
        connection = http.client.HTTPConnection('127.0.0.1', config['port'], timeout=4)
        body = request.get('body')
        connection.request(request['method'], request['path'],
                           body=None if body is None else body.encode('utf-8'),
                           headers=request.get('headers', {}))
        response = connection.getresponse()
        data, read_capped = read_body(response)
        body_bytes, truncated_bytes = len(data), truncate_at_limit(data)[0]
        truncated = len(data) > MAX_BODY_BYTES
        headers = {name: response.getheader(name) for name in config['response_headers']}
        if len(json.dumps(headers).encode()) > 4096:
            raise RuntimeError('Reference headers exceeded the budget')
        display = utf8_prefix_text(truncated_bytes)
        if display is None:
            display = '[non-UTF-8 response; see body_base64]'
        result = {'status': response.status,
                  'headers': headers,
                  'body': display,
                  'body_base64': base64.b64encode(truncated_bytes).decode('ascii'),
                  'body_bytes': body_bytes,
                  'body_truncated': truncated}
        if read_capped:
            result['body_read_capped'] = True
        return result
    finally:
        if connection is not None:
            connection.close()
        try:
            terminate_process_tree(process)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            kill_process_tree(process)
            process.wait(timeout=0.5)


if __name__ == '__main__':
    try:
        settings = json.loads(sys.argv[1])
        request_text = sys.stdin.buffer.read(8193)
        if len(request_text) > 8192:
            raise RuntimeError('Request exceeded budget')
        request = json.loads(request_text)
        print(json.dumps(probe(settings, request), ensure_ascii=True, sort_keys=True))
    except Exception as error:
        print('HTTP probe infrastructure failure: ' + str(error), file=sys.stderr)
        sys.exit(125)
