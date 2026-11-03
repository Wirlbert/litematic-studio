@echo off
rem Litematic Studio launcher
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo [!] Python not found. Install Python 3.9+ from python.org and try again.
  pause
  exit /b 1
)

%PY% -c "import litemapy" >nul 2>nul
if errorlevel 1 (
  echo Installing litemapy ...
  %PY% -m pip install litemapy
  if errorlevel 1 (
    echo [!] pip install failed. Run manually:  %PY% -m pip install litemapy
    pause
    exit /b 1
  )
)

%PY% server.py %*
pause
