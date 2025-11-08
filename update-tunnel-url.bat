@echo off
setlocal enabledelayedexpansion

echo ===========================================
echo Atualizar URL do Cloudflare Tunnel
echo ===========================================
echo.

REM Verificar se o log existe
set "LOG_FILE=C:\logs-nssm\cripto-tunnel.err.log"
if not exist "%LOG_FILE%" (
    echo [ERRO] Arquivo de log nao encontrado: %LOG_FILE%
    echo Verifique se o servico cripto-tunnel esta rodando.
    pause
    exit /b 1
)

echo [1/3] Extraindo URL do log do tunnel...
echo.

REM Buscar URL no log (formato: https://xxxxx.trycloudflare.com)
findstr /C:"trycloudflare.com" "%LOG_FILE%" >nul 2>&1
if errorlevel 1 (
    echo [AVISO] URL nao encontrada no log. O tunnel pode nao ter iniciado ainda.
    echo Aguarde alguns segundos e tente novamente.
    pause
    exit /b 1
)

REM Extrair a URL usando PowerShell
for /f "delims=" %%a in ('powershell -Command "Get-Content '%LOG_FILE%' | Select-String -Pattern 'https://[^\s]+trycloudflare\.com' | Select-Object -Last 1 | ForEach-Object { $_.Matches.Value }"') do (
    set "TUNNEL_URL=%%a"
)

if not defined TUNNEL_URL (
    echo [ERRO] Nao foi possivel extrair a URL do log.
    echo Tente abrir o log manualmente: %LOG_FILE%
    echo E procure por uma linha com "https://...trycloudflare.com"
    pause
    exit /b 1
)

echo [OK] URL encontrada: %TUNNEL_URL%
echo.

echo [2/3] Atualizando ALLOWED_ORIGINS no cripto-proxy/.env...
set "PROXY_ENV=C:\Projects\cripto-proxy\.env"

if not exist "%PROXY_ENV%" (
    echo [AVISO] Arquivo .env do proxy nao encontrado: %PROXY_ENV%
    echo Atualize manualmente o ALLOWED_ORIGINS com: %TUNNEL_URL%
) else (
    REM Atualizar ALLOWED_ORIGINS (substituir ou adicionar)
    powershell -Command "(Get-Content '%PROXY_ENV%') -replace 'ALLOWED_ORIGINS=.*', 'ALLOWED_ORIGINS=%TUNNEL_URL%' | Set-Content '%PROXY_ENV%'"
    
    REM Se nao tinha ALLOWED_ORIGINS, adicionar
    findstr /C:"ALLOWED_ORIGINS" "%PROXY_ENV%" >nul 2>&1
    if errorlevel 1 (
        echo ALLOWED_ORIGINS=%TUNNEL_URL%>> "%PROXY_ENV%"
    )
    
    echo [OK] ALLOWED_ORIGINS atualizado no .env do proxy
    echo.
    echo [AVISO] Reinicie o servico cripto-proxy para aplicar as mudancas:
    echo   nssm restart cripto-proxy
    echo.
)

echo [3/3] Atualizar BINANCE_PROXY_URL na Vercel
echo.
echo ===========================================
echo COPIE ESTA URL E COLE NA VERCEL:
echo ===========================================
echo.
echo %TUNNEL_URL%
echo.
echo ===========================================
echo INSTRUCOES:
echo ===========================================
echo 1. Acesse: https://vercel.com/dashboard
echo 2. Selecione o projeto: cripto-manager
echo 3. Va em: Settings ^> Environment Variables
echo 4. Edite ou crie: BINANCE_PROXY_URL
echo 5. Cole o valor: %TUNNEL_URL%
echo 6. Salve e faca redeploy
echo.
echo ===========================================
echo.

pause
