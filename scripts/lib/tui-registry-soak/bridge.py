import os, sys, pty, fcntl, termios, struct, select, json, base64, signal
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 140, 0, 0))
print(json.dumps({'pid': pid}), flush=True)
buffer = b''
while True:
    ready, _, _ = select.select([fd, sys.stdin.buffer], [], [], 1)
    if fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        if b'\x1b[6n' in data: os.write(fd, b'\x1b[1;1R')
        print(json.dumps({'data': base64.b64encode(data).decode()}), flush=True)
    if sys.stdin.buffer in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if not data: break
        buffer += data
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            command = json.loads(line)
            if 'write' in command: os.write(fd, command['write'].encode())
            if 'signal' in command: os.kill(pid, getattr(signal, command['signal']))
            if 'signalGroup' in command:
                try:
                    # A stopped Host must run its termination path as well.
                    if command['signalGroup'] == 'SIGTERM': os.killpg(pid, signal.SIGCONT)
                    os.killpg(pid, getattr(signal, command['signalGroup']))
                except ProcessLookupError: pass
_, status = os.waitpid(pid, 0)
print(json.dumps({'exitStatus': status}), flush=True)
