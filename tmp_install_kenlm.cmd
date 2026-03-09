@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files\Git\bin;%PATH%"
.\.venv\Scripts\python.exe -m pip install --upgrade --force-reinstall kenlm
