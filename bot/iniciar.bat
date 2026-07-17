@echo off
title Motor WhatsApp (multi-sessao)
color 0A

echo.
echo  ============================================
echo   MOTOR WHATSAPP - MULTI-SESSAO
echo  ============================================
echo.

cd /d "%~dp0"

echo  Verificando dependencias Node.js...
if not exist "node_modules" (
    echo  Instalando dependencias pela primeira vez...
    npm install
    echo  Instalacao concluida!
    echo.
)

echo  Iniciando o motor (engine.js)...
echo  Mantenha esta janela aberta. Feche para parar o monitoramento.
echo.
node engine.js

pause
