@echo off
echo Vocab Student App - local test server
echo Browser will open automatically. Keep this window open. Press Ctrl+C to stop.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000"
python -m http.server 8000
if errorlevel 1 py -m http.server 8000
pause
