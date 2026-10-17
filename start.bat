@echo off
setlocal

rem 切换到本脚本所在目录
cd /d "%~dp0"

rem 端口：可用第一个参数覆盖，默认 8770
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8770"

rem 检测 Python：优先 py 启动器，其次 python
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo [错误] 未找到 Python，请先安装 Python 3 并加入 PATH。
    pause
    exit /b 1
)

echo 正在启动 节点式工厂配平编辑器 ...
echo 地址: http://127.0.0.1:%PORT%/
echo 按 Ctrl+C 可停止服务。
echo.

rem 稍等片刻后自动打开浏览器（不阻塞当前窗口）
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:%PORT%/"

rem 前台运行服务器（关闭窗口或 Ctrl+C 即停止）
%PY% server.py %PORT%

endlocal
