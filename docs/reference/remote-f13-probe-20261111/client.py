#!/usr/bin/env python3
"""Minimal protocol-3 broker client for the F13 review probe (run as dshhost)."""
import json
import socket
import sys

path = sys.argv[1]
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(30)
sock.connect(path)
fp = sock.makefile('rwb', buffering=0)


def read_one():
    line = fp.readline()
    if not line:
        raise RuntimeError('broker closed the connection')
    return json.loads(line)


hello = read_one()
out = {'hello': hello, 'exchanges': []}
next_id = 0


def request(method, params):
    global next_id
    next_id += 1
    rid = next_id
    fp.write((json.dumps({'protocol': 3, 'id': rid, 'method': method, 'params': params}) + '\n').encode())
    while True:
        message = read_one()
        if message.get('id') == rid:
            out['exchanges'].append({'method': method, 'params': params, 'reply': message})
            return message


# Quota: the temp manifest gives vps-xfer an env window of 3 operations.
for index in range(4):
    request('openSftp', {'environmentId': 'vps-xfer'})

# Revocation and audit rotation: every denied request is audited but never
# charged, so this also produces enough lines for a 512-byte rotation budget.
for index in range(30):
    request('openSftp', {'environmentId': 'vps-xfer2'})

print(json.dumps(out, indent=1))
