#!/bin/bash
# MinecraftSniperServerAdminManager - 极简卸载脚本
# 功能：停止服务 → 禁用服务 → 删除脚本所在目录及其所有内容
# 注意：此操作不可恢复！

set -e

# ============================================================
# 颜色输出
# ============================================================
RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
RESET="\033[0m"

# ============================================================
# 获取脚本所在目录
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 服务名称
SERVICE_NAME="MinecraftSniperServerAdminManager"

# ============================================================
# 彩色输出
# ============================================================
cprint() {
    local color="$1"
    local text="$2"
    local color_code=""
    case "$color" in
        red) color_code="$RED" ;;
        green) color_code="$GREEN" ;;
        yellow) color_code="$YELLOW" ;;
        cyan) color_code="$CYAN" ;;
    esac
    echo -e "${color_code}${text}${RESET}"
}

# ============================================================
# 检查 root 权限
# ============================================================
check_root() {
    if [ "$EUID" -ne 0 ]; then
        cprint red "错误: 此脚本需要 root 权限运行"
        cprint yellow "请使用: sudo bash uninstall.sh"
        exit 1
    fi
}

# ============================================================
# 停止服务
# ============================================================
stop_service() {
    cprint cyan "正在停止服务 $SERVICE_NAME ..."

    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        systemctl stop "$SERVICE_NAME" 2>/dev/null && cprint green "服务已停止"
    fi

    # 清理残留进程
    pkill -f "node server.js" 2>/dev/null || true
}

# ============================================================
# 禁用并删除服务文件
# ============================================================
disable_service() {
    cprint cyan "正在禁用并删除服务..."

    if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
        systemctl disable "$SERVICE_NAME" 2>/dev/null
    fi

    local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
    if [ -f "$service_file" ]; then
        rm -f "$service_file"
        systemctl daemon-reload 2>/dev/null || true
        cprint green "服务文件已删除"
    fi
}

# ============================================================
# 删除整个项目目录
# ============================================================
delete_project() {
    cprint yellow "即将删除目录: $SCRIPT_DIR"
    cprint red "此操作不可恢复！"
    echo ""
    read -p "确认删除? 输入 'yes' 确认: " confirm

    if [[ "$confirm" != "yes" ]]; then
        cprint yellow "操作已取消"
        exit 0
    fi

    cprint red "正在删除目录..."
    cd /tmp || exit 1
    rm -rf "$SCRIPT_DIR"
    cprint green "目录已删除: $SCRIPT_DIR"
}

# ============================================================
# 主函数
# ============================================================
main() {
    cprint cyan "MinecraftSniper ServerAdmin Manager - 卸载脚本"
    cprint cyan "将要删除目录: $SCRIPT_DIR"
    echo ""

    check_root
    stop_service
    disable_service
    delete_project

    echo ""
    cprint green "卸载完成"
}

main "$@"