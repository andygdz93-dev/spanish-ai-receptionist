#!/usr/bin/env python3
"""One-use temporary SIP route switch and rollback; dry-run status is the default.
No credentials in this script. Requires the private preflight backup created
before any routing change. Never runs a test call or books an appointment.
"""
import argparse
import base64
import copy
import datetime
import subprocess
import hmac
import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path(os.environ['LOCALAPPDATA']) / 'VVS-Smilez-Phone-Pilot'
BACKUP = PRIVATE / 'original-dispatch-rule.json'
SETTINGS = ROOT / '.env.google-phone-test.local'
ORIGINAL = ROOT / '.env.local'
EXPECTED_ORIGINAL_AGENT = 'my-agent'
EXPECTED_TEST_AGENT = 'vvs-google-phone-test'
EXPECTED_RULE_ID = 'SDR_ty9Bjf2zg3jZ'
ALLOWED_FIELDS = [
    'sip_dispatch_rule_id', 'rule', 'trunk_ids', 'hide_phone_number',
    'inbound_numbers', 'numbers', 'name', 'metadata', 'attributes',
    'room_preset', 'room_config', 'media', 'krisp_enabled', 'media_encryption',
]

def load(path):
    result = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        match = re.fullmatch(r'([A-Z0-9_]+)=(.*)', line)
        if match:
            result[match.group(1)] = match.group(2)
    return result

def update_switch(value):
    text = SETTINGS.read_text(encoding='utf-8')
    pattern = r'(?m)^VVS_PHONE_TEST_ROUTE_ACTIVE=(?:yes|no)$'
    if len(re.findall(pattern, text)) != 1:
        raise RuntimeError('Missing or malformed private safety switch')
    SETTINGS.write_text(
        re.sub(pattern, 'VVS_PHONE_TEST_ROUTE_ACTIVE=' + value, text),
        encoding='utf-8',
    )

def token_from(env):
    def b64(data):
        return base64.urlsafe_b64encode(data).decode().rstrip('=')
    now = int(time.time())
    h = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'},
                       separators=(',', ':')).encode())
    p = b64(json.dumps({'iss': env['LIVEKIT_API_KEY'],
                        'iat': now-10, 'exp': now+90,
                        'sip': {'admin': True}}, separators=(',', ':')).encode())
    raw = h + '.' + p
    return raw + '.' + b64(hmac.new(
        env['LIVEKIT_API_SECRET'].encode(),
        raw.encode(), hashlib.sha256
    ).digest())

def sip_request(env, name, body):
    url = urllib.parse.urlsplit(env['LIVEKIT_URL'])
    if url.scheme != 'wss' or not url.hostname or not url.hostname.endswith('.livekit.cloud'):
        raise RuntimeError('Invalid original project LiveKit endpoint')
    endpoint = 'https://' + url.hostname + '/twirp/livekit.SIP/' + name
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token_from(env),
                 'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode())

def read_rule(original):
    items = sip_request(original, 'ListSIPDispatchRule', {}).get('items', [])
    rule = [r for r in items if r.get('sip_dispatch_rule_id') == EXPECTED_RULE_ID]
    if len(rule) != 1:
        raise RuntimeError('Expected original dispatch rule was not found')
    return rule[0]

def agent_name(rule):
    agents = (rule.get('room_config') or {}).get('agents', [])
    names = [a.get('agent_name', a.get('agentName')) for a in agents]
    if len(names) != 1:
        raise RuntimeError('Unexpected number of agents in dispatch rule')
    return names[0]

def clean(rule):
    return {k: rule[k] for k in ALLOWED_FIELDS if k in rule}

def replace_agent(rule, new_agent):
    result = copy.deepcopy(clean(rule))
    agents = result['room_config']['agents']
    if len(agents) != 1:
        raise RuntimeError('Refuse to modify a multi-agent routing rule')
    agents[0]['agent_name'] = new_agent
    agents[0].pop('agentName', None)
    return result

def set_rule(original, desired):
    result = sip_request(original, 'UpdateSIPDispatchRule', {
        'sip_dispatch_rule_id': EXPECTED_RULE_ID,
        'replace': desired,
    })
    if result.get('sip_dispatch_rule_id') != EXPECTED_RULE_ID:
        raise RuntimeError('Unexpected dispatch update response')
    verified = read_rule(original)
    if clean(verified) != clean(desired):
        raise RuntimeError('Remote dispatch rule does not match requested configuration')
    return verified

def port_listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False

def validate_armed_job_config():
    """Check the per-call child import under the FUTURE armed state, before routing."""
    script = (
        "import { readFileSync } from 'node:fs';"
        "import { parse } from 'dotenv';"
        "import { readPhoneTestConfig } from './src/google-pilot/phone-config.ts';"
        "const phone=parse(readFileSync('.env.google-phone-test.local','utf8'));"
        "const isolated=parse(readFileSync('.env.google-pilot.local','utf8'));"
        "const original=parse(readFileSync('.env.local','utf8'));"
        "phone.VVS_PHONE_TEST_ROUTE_ACTIVE='yes';"
        "readPhoneTestConfig(phone,isolated,original);"
        "process.stdout.write('ARMED_CHILD_IMPORT_CONFIG_VALID=True\\n');"
    )
    check = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd=ROOT, capture_output=True, text=True, timeout=20, check=False,
    )
    if check.returncode != 0 or 'ARMED_CHILD_IMPORT_CONFIG_VALID=True' not in check.stdout:
        raise RuntimeError('Per-call child module would fail when the telephone route is armed')
    print('ARMED_CHILD_IMPORT_CONFIG_VALID=True')

def schedule_rollback():
    """Fail closed if Windows cannot schedule original-number restoration."""
    now = datetime.datetime.now()
    deadline = now + datetime.timedelta(minutes=12)
    if deadline.date() != now.date():
        raise RuntimeError('Automatic rollback scheduler cannot cross midnight')
    name = 'VVS-Smilez-Phone-Test-Restore'
    command = subprocess.list2cmdline([sys.executable, str(Path(__file__).resolve()), 'restore'])
    create = subprocess.run(
        ['schtasks.exe', '/Create', '/TN', name, '/TR', command,
         '/SC', 'ONCE', '/ST', deadline.strftime('%H:%M'),
         '/F'],
        capture_output=True, text=True, timeout=20, check=False,
    )
    if create.returncode != 0:
        raise RuntimeError('Windows automatic route rollback could not be scheduled')
    verify = subprocess.run(
        ['schtasks.exe', '/Query', '/TN', name],
        capture_output=True, text=True, timeout=15, check=False,
    )
    if verify.returncode != 0:
        raise RuntimeError('Windows rollback task could not be verified')
    print('ROLLBACK_TASK_SCHEDULED=True')
    print('ROLLBACK_AFTER_MINUTES=12')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=['status', 'activate', 'restore'],
                        default='status')
    parser.add_argument('--authorized-now', action='store_true',
                        help='Required for any switch away from the current receptionist')
    args = parser.parse_args()
    cfg = load(SETTINGS)
    orig = load(ORIGINAL)
    if cfg.get('VVS_PHONE_TEST_EXPECTED_RULE_ID') != EXPECTED_RULE_ID:
        raise RuntimeError('Original rule ID changed in local settings')
    if cfg.get('VVS_PHONE_TEST_PREPARED') != 'yes':
        raise RuntimeError('Phone worker not prepared')
    if cfg.get('VVS_PHONE_TEST_CALLED_NUMBER') != '+12402128082':
        raise RuntimeError('Review phone number before switching')
    if not BACKUP.is_file():
        raise RuntimeError('Private original routing backup missing')
    backup = json.loads(BACKUP.read_text(encoding='utf-8'))
    if agent_name(backup) != EXPECTED_ORIGINAL_AGENT:
        raise RuntimeError('Backup is not for original my-agent')
    active = read_rule(orig)
    actual_agent = agent_name(active)
    armed = cfg.get('VVS_PHONE_TEST_ROUTE_ACTIVE') == 'yes'
    print('CURRENT_ROUTE_AGENT=' + actual_agent)
    print('PHONE_BRIDGE_ARMED=' + str(armed))
    print('ORIGINAL_WORKER_LISTENING=' + str(port_listening(8081)))
    print('TEST_WORKER_LISTENING=' + str(port_listening(18083)))
    if args.action == 'status':
        print('ROUTE_UNCHANGED=' + str(actual_agent == EXPECTED_ORIGINAL_AGENT))
        print('ORIGINAL_BACKUP_MATCHES=' + str(clean(active) == clean(backup)))
        return

    if args.action == 'activate':
        if not args.authorized_now:
            raise RuntimeError('Need explicit one-time authorization to interrupt existing phone routing')
        if armed or actual_agent != EXPECTED_ORIGINAL_AGENT or clean(active) != clean(backup):
            raise RuntimeError('Phone route already modified or remote backup mismatch')
        if not (port_listening(8081) and port_listening(18083)):
            raise RuntimeError('Both the original and temporary workers must be healthy')
        state = cfg.get('VVS_PHONE_TEST_STATE_PATH', '')
        if not state or Path(state).exists():
            raise RuntimeError('One-use phone test state already exists or is not configured')
        desired = replace_agent(backup, EXPECTED_TEST_AGENT)
        validate_armed_job_config()
        schedule_rollback()
        try:
            set_rule(orig, desired)
            update_switch('yes')
        except Exception:
            # A network/readback error may occur AFTER the server changes the route.
            # Disarm Calendar writes immediately, then restore only our known test route.
            update_switch('no')
            current = read_rule(orig)
            if agent_name(current) == EXPECTED_TEST_AGENT:
                set_rule(orig, clean(backup))
            raise
        print('TEMPORARY_ROUTE_ACTIVATED=True')
        print('CALL_THE_EXISTING_NUMBER_NOW=True')
        print('IMPORTANT_RESTORE_AFTER_CALL=True')
        return

    # Rollback first disarms booking tools, even if LiveKit is unreachable.
    update_switch('no')
    if actual_agent == EXPECTED_ORIGINAL_AGENT:
        if clean(active) != clean(backup):
            raise RuntimeError('Original agent but unexpected routing fields, manual investigation needed')
        print('ORIGINAL_ROUTE_ALREADY_ACTIVE=True')
        return
    if actual_agent != EXPECTED_TEST_AGENT:
        raise RuntimeError('Refuse to overwrite unknown concurrent routing change')
    expected_temporary = replace_agent(backup, EXPECTED_TEST_AGENT)
    if clean(active) != clean(expected_temporary):
        raise RuntimeError('Unexpected dispatch changes; refusing unsafe rollback')
    set_rule(orig, clean(backup))
    print('ORIGINAL_ROUTE_RESTORED_AND_VERIFIED=True')

if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as ex:
        print('LIVEKIT_ROUTE_API_FAILED_HTTP=' + str(ex.code), file=sys.stderr)
        sys.exit(1)
    except Exception as ex:
        print('ROUTE_CONTROL_FAILED=' + str(ex), file=sys.stderr)
        sys.exit(1)
