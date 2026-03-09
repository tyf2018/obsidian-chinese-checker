@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "SCRIPT_DIR=%cd%"
set "DEFAULT_VENV_DIR=S:\obsidian-chinese-checker\.venv"
set "INPUT_PATH=%~1"
set "PYTHON_EXE="
set "CANDIDATE="

if defined INPUT_PATH call :try_resolve_python "%INPUT_PATH%"
if not defined PYTHON_EXE call :try_resolve_python "%DEFAULT_VENV_DIR%"
if not defined PYTHON_EXE call :try_resolve_python "%SCRIPT_DIR%\.venv"

if not defined PYTHON_EXE (
  where py >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%I in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do (
      if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
    )
  )
)

if not defined PYTHON_EXE (
  where python >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%I in ('python -c "import sys;print(sys.executable)" 2^>nul') do (
      if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
    )
  )
)

if not defined PYTHON_EXE (
  echo [ERROR] Python 3 not found.
  pause
  exit /b 1
)

echo [INFO] Using Python: "%PYTHON_EXE%"
"%PYTHON_EXE%" "%SCRIPT_DIR%\check_pycorrector_env.py"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [DONE] Environment check passed.
) else (
  echo [FAIL] Environment check failed. Please review output above.
)
echo.
pause
exit /b %CODE%

:try_resolve_python
set "RAW=%~1"
if not defined RAW exit /b 0
set "RAW=%RAW:"=%"
if /I "%RAW:~-10%"=="python.exe" (
  set "CANDIDATE=%RAW%"
) else (
  for %%I in ("%RAW%") do set "CANDIDATE=%%~fI\Scripts\python.exe"
)
if exist "%CANDIDATE%" set "PYTHON_EXE=%CANDIDATE%"
exit /b 0
