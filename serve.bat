@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8765"
set "FILE=github-turbo.js"
set "NAME=github-turbo.user.js"
set "DIR=.serve"
set "SERVER=scripts\serve.py"
set "URL=http://127.0.0.1:%PORT%/%DIR%/%NAME%"

rem ---- 找一个能用的 Python 3：优先 python，其次 py -3 ----
set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo [错误] 未找到 python / py，请安装 Python 3 并勾选 "Add Python to PATH"。
  pause
  exit /b 1
)

rem where 可能命中的是 Microsoft Store 的占位别名（一执行就跳商店），
rem 必须实跑一次确认解释器真的可用，否则服务会在最小化窗口里静默失败。
%PY% -c "import sys" >nul 2>nul
if errorlevel 1 (
  echo [错误] %PY% 无法执行，可能是 Microsoft Store 的占位别名。
  echo        请安装真正的 Python 3，并确认命令行里 python -c "import sys" 能跑通。
  pause
  exit /b 1
)

if not exist "%FILE%" (
  echo [错误] 未找到 %FILE%，请确认脚本就在本目录下。
  pause
  exit /b 1
)
if not exist "%SERVER%" (
  echo [错误] 未找到 %SERVER%，无法启动安装服务。
  pause
  exit /b 1
)

rem ---- 端口被占用 ----
rem 旧版这里只是报错退出。上次的 python http.server 还活着时，浏览器会继续拿到那个
rem 不带 charset 的旧响应（整页乱码），用户会以为「改了没用」。所以先判断占用者是不是
rem python：是就收掉，不是才报错。
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do set "PID=%%p"
if not defined PID goto portfree

tasklist /nh /fi "PID eq %PID%" 2>nul | findstr /i "python py.exe" >nul 2>nul
if errorlevel 1 (
  echo [错误] 端口 %PORT% 被其他程序占用（PID %PID%），请先关掉它，或修改本文件里的 PORT。
  pause
  exit /b 1
)
echo 端口 %PORT% 被上次残留的 python（PID %PID%）占用，正在停止它...
taskkill /pid %PID% /f >nul 2>nul
timeout /t 1 >nul

:portfree
rem 脚本管理器只在地址以 .user.js 结尾时才弹安装页，
rem 所以这里复制一份别名文件，真正的源码仍然只有 %FILE% 一份。
if not exist "%DIR%" mkdir "%DIR%"
copy /y "%FILE%" "%DIR%\%NAME%" >nul
if errorlevel 1 (
  echo [错误] 无法生成 %DIR%\%NAME%，请检查目录权限。
  pause
  exit /b 1
)

echo ==========================================================
echo   GitHub Turbo 本地安装服务
echo   地址: %URL%
echo   服务在最小化窗口中运行，关闭该窗口即停止服务。
echo ==========================================================
echo.

rem 用 scripts\serve.py 而不是 python -m http.server：标准库给的 Content-Type 不带
rem charset，中文 Windows 上浏览器会按 CP936 解码 UTF-8 脚本，安装页直接是乱码。
start "" /min %PY% "%SERVER%" %PORT%
timeout /t 2 >nul

rem ---- 启动后自检：响应头必须带 charset=utf-8 且内容是用户脚本 ----
%PY% -c "import sys,urllib.request as u;r=u.urlopen(sys.argv[1],timeout=5);ct=r.headers.get('Content-Type','');b=r.read();sys.exit(0 if ('charset=utf-8' in ct.lower() and b'==UserScript==' in b) else 1)" "%URL%" >nul 2>nul
if errorlevel 1 (
  echo [警告] 服务已启动，但自检没通过：取到的内容不是正常的 UTF-8 用户脚本。
  echo        请手动打开 %URL% 确认；若仍是乱码，先关掉所有 python 进程再重跑本文件。
) else (
  echo 自检通过：脚本以 UTF-8 提供，安装页不会乱码。
)

echo 正在打开浏览器...
start "" "%URL%"

echo.
echo 应该会弹出脚本管理器的安装页；如果只是显示源码，请全选复制后
echo 粘贴到脚本管理器里新建脚本，效果相同。
echo 如果提示无法访问：确认 %PORT% 端口没有被占用，或先关闭系统代理。
echo.
timeout /t 5 >nul
endlocal
