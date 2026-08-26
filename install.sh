#!/bin/bash
# MinecraftSniperServerAdminManager - Linux 一键安装脚本
# 适用系统: Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Arch Linux
# 说明: 用户解压到任意目录后，在目录内运行 sudo ./install.sh 即可
#       脚本自动检测项目根目录（脚本自身所在目录）

set -e

# ============================================================
# 颜色和样式
# ============================================================
RESET="\033[0m"
RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
WHITE="\033[0;37m"
BOLD="\033[1m"

# ============================================================
# 获取脚本自身所在目录（项目根目录）
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"

# ============================================================
# 默认配置
# ============================================================
INSTALL_USER=""
NODE_VERSION="v20.12.2"
NODE_VERSION_CENTOS7="v16.20.2"
SERVICE_NAME="MinecraftSniperServerAdminManager"
SERVICE_PORT="8035"
PKG_MANAGER=""
PKG_UPDATE=""
PKG_INSTALL=""

# ============================================================
# 检测终端颜色支持
# ============================================================
detect_terminal_capabilities() {
    if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
        if [ "$(tput colors)" -ge 8 ]; then
            return 0
        fi
    fi
    RESET=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; WHITE=""; BOLD=""
}

# ============================================================
# 彩色输出函数
# ============================================================
cprint() {
    local color=""
    local text=""
    local styles=""
    local disable_prefix=false
    local disable_newline=false

    while [[ $# -gt 1 ]]; do
        case "$1" in
            red|green|yellow|cyan|white)
                color="$1"
                ;;
            bold)
                styles="${BOLD}"
                ;;
            noprefix)
                disable_prefix=true
                ;;
            nonl)
                disable_newline=true
                ;;
        esac
        shift
    done

    text="$1"

    local prefix_text=""
    if [[ "$disable_prefix" != true ]]; then
        prefix_text="[$(date +%H:%M:%S)] [Installer] "
    fi

    local color_code=""
    case "$color" in
        red) color_code="$RED" ;;
        green) color_code="$GREEN" ;;
        yellow) color_code="$YELLOW" ;;
        cyan) color_code="$CYAN" ;;
        white) color_code="$WHITE" ;;
    esac

    if [[ "$disable_newline" == true ]]; then
        printf "%s%s%s%s%s" "$prefix_text" "$styles" "$color_code" "$text" "$RESET"
    else
        printf "%s%s%s%s%s\n" "$prefix_text" "$styles" "$color_code" "$text" "$RESET"
    fi
}

# ============================================================
# 检查 root 权限
# ============================================================
check_root() {
    if [ "$EUID" -ne 0 ]; then
        cprint red "错误: 此脚本需要 root 权限运行"
        cprint yellow "请使用: sudo bash install.sh"
        exit 1
    fi
}

# ============================================================
# 检测操作系统
# ============================================================
detect_os() {
    local distro="Unknown"
    local version="Unknown"
    local arch=$(uname -m)

    if [ -f /etc/os-release ]; then
        . /etc/os-release
        case "${ID,,}" in
            ubuntu|debian)
                distro="Debian"
                version="$VERSION_ID"
                PKG_MANAGER="apt"
                PKG_UPDATE="apt update -y"
                PKG_INSTALL="apt install -y"
                ;;
            centos|rhel|rocky|almalinux|fedora)
                distro="RHEL"
                version="$VERSION_ID"
                if command -v dnf >/dev/null 2>&1; then
                    PKG_MANAGER="dnf"
                    PKG_UPDATE="dnf update -y"
                    PKG_INSTALL="dnf install -y"
                else
                    PKG_MANAGER="yum"
                    PKG_UPDATE="yum update -y"
                    PKG_INSTALL="yum install -y"
                fi
                if [[ "$version" == "7"* ]]; then
                    NODE_VERSION="$NODE_VERSION_CENTOS7"
                fi
                ;;
            arch)
                distro="Arch"
                version="rolling"
                PKG_MANAGER="pacman"
                PKG_UPDATE="pacman -Sy"
                PKG_INSTALL="pacman -S --noconfirm"
                ;;
            *)
                distro="${ID:-Unknown}"
                version="$VERSION_ID"
                PKG_MANAGER="unknown"
                ;;
        esac
    fi

    cprint cyan "检测到操作系统: $distro $version"
    cprint cyan "检测到架构: $arch"
    cprint cyan "包管理器: $PKG_MANAGER"
}

# ============================================================
# 检查必要命令
# ============================================================
check_required_commands() {
    local missing=0
    local cmds=("curl" "wget" "tar" "systemctl")

    for cmd in "${cmds[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            cprint yellow "警告: 命令 '$cmd' 未找到，将尝试安装"
            missing=1
        fi
    done

    if [ "$missing" -eq 1 ]; then
        cprint cyan "正在安装缺失的工具..."
        case "$PKG_MANAGER" in
            apt)
                $PKG_UPDATE
                $PKG_INSTALL curl wget tar systemd
                ;;
            dnf|yum)
                $PKG_UPDATE
                $PKG_INSTALL curl wget tar systemd
                ;;
            pacman)
                $PKG_UPDATE
                $PKG_INSTALL curl wget tar systemd
                ;;
            *)
                cprint yellow "请手动安装: curl, wget, tar, systemd"
                ;;
        esac
    fi
}

# ============================================================
# 检查并安装 Node.js
# ============================================================
install_nodejs() {
    if command -v node >/dev/null 2>&1; then
        local current_version=$(node -v)
        cprint green "检测到 Node.js: $current_version"
        local required_ver="${NODE_VERSION#v}"
        if [[ "$current_version" == "v$required_ver"* ]] || [[ "$(printf '%s\n' "$required_ver" "$current_version" | sort -V | head -1)" == "$required_ver" ]]; then
            cprint green "Node.js 版本满足要求"
            return 0
        else
            cprint yellow "Node.js 版本较旧 ($current_version)，将安装新版本"
        fi
    fi

    cprint cyan "正在安装 Node.js $NODE_VERSION ..."

    case "$PKG_MANAGER" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            $PKG_INSTALL nodejs
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
            $PKG_INSTALL nodejs
            ;;
        pacman)
            $PKG_INSTALL nodejs npm
            ;;
        *)
            cprint yellow "请手动安装 Node.js $NODE_VERSION"
            cprint yellow "访问: https://nodejs.org/"
            exit 1
            ;;
    esac

    if command -v node >/dev/null 2>&1; then
        cprint green "Node.js 安装成功: $(node -v)"
    else
        cprint red "Node.js 安装失败"
        exit 1
    fi
}

# ============================================================
# 安装 pnpm（使用 npm install -g）
# ============================================================
install_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        cprint green "检测到 pnpm: $(pnpm -v)"
        return 0
    fi

    cprint cyan "正在安装 pnpm (通过 npm install -g)..."

    if ! command -v npm >/dev/null 2>&1; then
        cprint red "npm 未找到，请确保 Node.js 安装正确"
        exit 1
    fi

    if npm install -g pnpm; then
        cprint green "pnpm 安装成功: $(pnpm -v)"
    else
        cprint red "pnpm 安装失败"
        exit 1
    fi
}

# ============================================================
# 检查项目文件
# ============================================================
check_project_files() {
    local required_files=(
        "adminserver.js"
        "server.js"
        "package.json"
        "public/admin.html"
        "public/login.html"
    )

    cprint cyan "检查项目文件 (目录: $INSTALL_DIR)..."

    for file in "${required_files[@]}"; do
        if [ ! -f "$INSTALL_DIR/$file" ]; then
            cprint red "错误: 缺少项目文件: $file"
            cprint yellow "请确保在项目根目录下运行此脚本"
            cprint yellow "当前目录: $INSTALL_DIR"
            exit 1
        fi
    done

    cprint green "项目文件检查通过"
}

# ============================================================
# 安装项目依赖
# ============================================================
install_dependencies() {
    cprint cyan "正在安装项目依赖..."

    cd "$INSTALL_DIR" || exit 1

    if ! pnpm install; then
        cprint red "依赖安装失败"
        exit 1
    fi

    cprint green "依赖安装完成"

    cprint cyan "正在批准 node-pty 构建脚本..."
    if command -v pnpm >/dev/null 2>&1; then
        pnpm approve-builds --all 2>/dev/null || true
    fi

    cprint green "所有依赖已就绪"
}

# ============================================================
# 获取当前用户（用于服务）
# ============================================================
get_install_user() {
    if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
        INSTALL_USER="$SUDO_USER"
    elif [ -n "$USER" ] && [ "$USER" != "root" ]; then
        INSTALL_USER="$USER"
    else
        INSTALL_USER="root"
    fi
    cprint cyan "安装用户: $INSTALL_USER"
}

# ============================================================
# 创建 systemd 服务
# ============================================================
create_systemd_service() {
    local service_path="/etc/systemd/system/${SERVICE_NAME}.service"
    local exec_path=$(command -v node)

    if [ -z "$exec_path" ]; then
        cprint red "找不到 node 可执行文件"
        exit 1
    fi

    cprint cyan "正在创建 systemd 服务: $service_path"
    cprint cyan "工作目录: $INSTALL_DIR"
    cprint cyan "Node.js 路径: $exec_path"

    cat > "$service_path" <<EOF
[Unit]
Description=MinecraftSniper ServerAdmin Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${exec_path} server.js
Restart=on-failure
User=${INSTALL_USER}
Environment="NODE_ENV=production"
Environment="PATH=${PATH}"

[Install]
WantedBy=multi-user.target
EOF

    if [ $? -ne 0 ]; then
        cprint red "创建服务文件失败"
        exit 1
    fi

    chmod 644 "$service_path"
    cprint green "服务文件创建成功"

    systemctl daemon-reload

    if systemctl enable "$SERVICE_NAME" 2>/dev/null; then
        cprint green "已启用服务: $SERVICE_NAME (开机自启)"
    else
        cprint yellow "启用服务失败（不影响当前运行）"
    fi
}

# ============================================================
# 启动服务
# ============================================================
start_service() {
    cprint cyan "正在启动服务..."

    if systemctl start "$SERVICE_NAME" 2>/dev/null; then
        cprint green "服务已启动"
        sleep 2
        if systemctl status "$SERVICE_NAME" --no-pager >/dev/null 2>&1; then
            cprint green "服务运行正常"
        else
            cprint yellow "服务状态未知，请检查: systemctl status $SERVICE_NAME"
        fi
    else
        cprint yellow "systemd 启动失败，尝试直接运行..."
        cd "$INSTALL_DIR"
        nohup node server.js > /dev/null 2>&1 &
        cprint green "服务已在后台启动 (PID: $!)"
        cprint yellow "注意: 直接运行模式不会开机自启"
    fi
}

# ============================================================
# 获取本机 IP
# ============================================================
get_local_ip() {
    local ip=""
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$ip" ]; then
        ip=$(ip addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -1)
    fi
    if [ -z "$ip" ]; then
        ip="你的IP"
    fi
    echo "$ip"
}

# ============================================================
# 读取端口配置
# ============================================================
get_service_port() {
    local config_file="$INSTALL_DIR/adminconfig.json"
    if [ -f "$config_file" ]; then
        local port=$(grep -oP '"adminPort"\s*:\s*\K\d+' "$config_file" 2>/dev/null | head -1)
        if [ -n "$port" ]; then
            SERVICE_PORT="$port"
        fi
    fi
}

# ============================================================
# 打印安装结果
# ============================================================
print_result() {
    clear 2>/dev/null || true

    local ip=$(get_local_ip)

    cprint white noprefix "============================================"
    cprint white noprefix "  MinecraftSniper ServerAdmin Manager"
    cprint white noprefix "  安装完成"
    cprint white noprefix "============================================"
    echo ""

    cprint yellow noprefix "📍 安装目录:"
    cprint white noprefix "  $INSTALL_DIR"
    echo ""

    cprint yellow noprefix "🌐 访问地址:"
    cprint white noprefix "  http://${ip}:${SERVICE_PORT}/login.html"
    if [ -f "$INSTALL_DIR/sslkey/MinecraftSniper.crt" ]; then
        cprint white noprefix "  https://${ip}:${SERVICE_PORT}/login.html (证书已检测到)"
    fi
    echo ""

    cprint yellow noprefix "📦 服务管理:"
    cprint white noprefix "  启动: systemctl start ${SERVICE_NAME}"
    cprint white noprefix "  停止: systemctl stop ${SERVICE_NAME}"
    cprint white noprefix "  重启: systemctl restart ${SERVICE_NAME}"
    cprint white noprefix "  状态: systemctl status ${SERVICE_NAME}"
    echo ""

    cprint yellow noprefix "📋 查看日志:"
    cprint white noprefix "  journalctl -u ${SERVICE_NAME} -f"
    echo ""

    cprint yellow noprefix "⚙️  配置文件:"
    cprint white noprefix "  $INSTALL_DIR/adminconfig.json"
    echo ""

    cprint yellow noprefix "🔐 安全提示:"
    cprint white noprefix "  1. 首次访问请使用私钥登录（密钥在登录页生成）"
    cprint white noprefix "  2. 请勿将端口 ${SERVICE_PORT} 直接暴露到公网"
    cprint white noprefix "  3. 建议通过 VPN 或内网访问管理面板"
    echo ""

    cprint green noprefix "============================================"
    cprint green noprefix "  🎉 安装完成，祝使用愉快！"
    cprint green noprefix "============================================"
}

# ============================================================
# 主函数
# ============================================================
main() {
    cprint cyan bold "MinecraftSniper ServerAdmin Manager - 一键安装脚本"
    cprint cyan "项目目录: $INSTALL_DIR"
    echo ""

    detect_terminal_capabilities
    check_root
    detect_os
    check_required_commands

    cprint cyan "安装目录: $INSTALL_DIR"
    check_project_files
    get_install_user

    install_nodejs
    install_pnpm
    install_dependencies

    get_service_port
    create_systemd_service
    start_service

    print_result
}

main "$@"