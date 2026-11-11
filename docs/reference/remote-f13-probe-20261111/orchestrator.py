#!/usr/bin/env python3
"""Controlled F13 probe against a temporary broker instance on .87.

Does not touch the production broker: separate manifest/config/socket/audit
under /etc/dsh-*-f13 and /tmp/f13-review. Runs the real remote-broker.js as the
dedicated broker account and a protocol-3 client as the Host account (uid 1000).
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time

BASE = '/tmp/f13-review'
CONFIG_DIR = '/etc/dsh-ssh-broker-f13'
MANIFEST_DIR = '/etc/dsh-remote-f13'
CONFIG = os.path.join(CONFIG_DIR, 'broker.json')
MANIFEST = os.path.join(MANIFEST_DIR, 'manifest.json')
SOCK = os.path.join(BASE, 'broker.sock')
AUDIT = os.path.join(BASE, 'audit.jsonl')
BROKER = '/opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace/lib/remote-broker.js'
NODE = '/opt/node-v24/bin/node'

# A copy of the production manifest with a small env window for vps-xfer and an
# explicit revocation for vps-xfer2. The digest is taken from the broker hello.
production = json.load(open('/etc/dsh-remote/manifest.json'))
production['quotas'] = {'windowMs': 60_000, 'maxOperations': 100, 'maxBytes': 1024 * 1024}
for environment in production['environments']:
    if environment['environmentId'] == 'vps-xfer':
        environment['quotas'] = {'windowMs': 60_000, 'maxOperations': 3, 'maxBytes': 1024 * 1024}
production['revocations'] = [{'environmentId': 'vps-xfer2', 'reason': 'f13 review probe'}]

os.makedirs(MANIFEST_DIR, exist_ok=True)
os.chmod(MANIFEST_DIR, 0o755)
with open(MANIFEST, 'w', encoding='utf-8') as handle:
    json.dump(production, handle, indent=1)
    handle.write('\n')
os.chmod(MANIFEST, 0o644)

config = {
    'manifestPath': MANIFEST,
    'socketPath': SOCK,
    'clientUid': 1000,
    'brokerUid': 996,
    'auditPath': AUDIT,
    'auditMaxBytes': 512,
    'auditKeep': 3,
}
os.makedirs(CONFIG_DIR, exist_ok=True)
os.chmod(CONFIG_DIR, 0o755)
with open(CONFIG, 'w', encoding='utf-8') as handle:
    json.dump(config, handle, indent=2)
    handle.write('\n')
os.chmod(CONFIG, 0o644)

shutil.rmtree(BASE, ignore_errors=True)
os.makedirs(BASE)
os.chown(BASE, 996, 987)
os.chmod(BASE, 0o750)

broker_log = open(os.path.join(BASE, 'broker.log'), 'wb')
broker = subprocess.Popen(
    ['runuser', '-u', '_dsh_ssh', '-g', 'dsh-ssh-clients', '--', NODE, BROKER, '--config', CONFIG],
    stdout=broker_log, stderr=subprocess.STDOUT,
    env={'HOME': '/var/lib/dsh-ssh-broker', 'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'},
)

try:
    for _ in range(100):
        if os.path.exists(SOCK):
            break
        if broker.poll() is not None:
            break
        time.sleep(0.1)
    if not os.path.exists(SOCK):
        print('broker did not create the socket', file=sys.stderr)
        print(open(os.path.join(BASE, 'broker.log'), 'r', errors='replace').read()[-4000:], file=sys.stderr)
        sys.exit(1)

    # The broker owns the socket and runs with the client group; make the grant
    # explicit so the dshhost client can connect without relying on umask.
    os.chown(SOCK, 996, 987)
    os.chmod(SOCK, 0o660)

    result = subprocess.run(
        ['runuser', '-u', 'dshhost', '--', 'python3', '/tmp/f13-review-src/client.py', SOCK],
        capture_output=True, text=True, timeout=120,
    )
    with open(os.path.join(BASE, 'client.out'), 'w', encoding='utf-8') as handle:
        handle.write(result.stdout)
    with open(os.path.join(BASE, 'client.err'), 'w', encoding='utf-8') as handle:
        handle.write(result.stderr)
finally:
    broker.terminate()
    try:
        broker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        broker.kill()
        broker.wait()
    broker_log.close()

audit_files = []
for name in sorted(os.listdir(BASE)):
    if not name.startswith('audit.jsonl'):
        continue
    stat = os.stat(os.path.join(BASE, name))
    audit_files.append({
        'name': name,
        'mode': oct(stat.st_mode & 0o777),
        'uid': stat.st_uid,
        'gid': stat.st_gid,
        'size': stat.st_size,
    })

client_json = None
try:
    client_json = json.load(open(os.path.join(BASE, 'client.out'), encoding='utf-8'))
except Exception:
    pass
summary = {
    'manifest': {
        'path': MANIFEST,
        'globalQuotas': production.get('quotas'),
        'vpsXferQuotas': next(e.get('quotas') for e in production['environments'] if e['environmentId'] == 'vps-xfer'),
        'revocations': production.get('revocations'),
    },
    'brokerLogTail': open(os.path.join(BASE, 'broker.log'), 'r', errors='replace').read()[-3000:],
    'clientExit': result.returncode if 'result' in locals() else None,
    'hello': client_json.get('hello') if client_json else None,
    'quotaReplies': None,
    'revocationReplies': None,
    'auditFiles': audit_files,
}
if client_json:
    exchanges = client_json.get('exchanges', [])
    summary['quotaReplies'] = [
        entry['reply'] for entry in exchanges[:4]
    ]
    summary['revocationReplies'] = [
        entry['reply'].get('code') if entry['reply'].get('ok') is False else 'ok'
        for entry in exchanges[4:]
    ]
with open(os.path.join(BASE, 'summary.json'), 'w', encoding='utf-8') as handle:
    json.dump(summary, handle, indent=2)
    handle.write('\n')
print(json.dumps(summary, indent=2))
