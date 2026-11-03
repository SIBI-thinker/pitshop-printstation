@echo off
cd /d "%~dp0.."
rem Open the counter screen once the server has had a moment to start.
start "" cmd /c "timeout /t 4 >nul & start msedge --app=http://localhost/counter/"
node index.js
pause
