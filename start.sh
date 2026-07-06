#!/bin/bash
cd "$(dirname "$0")"
PORT=8787
echo "비즈보드 아카이브를 http://localhost:$PORT 에서 실행합니다..."
open "http://localhost:$PORT" 2>/dev/null
python3 -m http.server "$PORT"
