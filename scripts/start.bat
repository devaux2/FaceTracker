@echo off
REM Serve FaceTracker over http://localhost and open the control panel + display.
cd /d "%~dp0\.."
set PORT=8000

where py >nul 2>nul && (set PY=py) || (set PY=python)

start "FaceTracker server" %PY% -m http.server %PORT%
timeout /t 1 >nul

start "" "http://localhost:%PORT%/control.html"

REM Launch the display as a borderless Chrome app window (edit path if needed):
start "" chrome --app="http://localhost:%PORT%/display.html"

echo FaceTracker is serving at http://localhost:%PORT%
echo Control: http://localhost:%PORT%/control.html
echo Display: http://localhost:%PORT%/display.html
