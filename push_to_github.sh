#!/usr/bin/env bash
# ============================================================
# 一键把新系统（order-management-v2）推送到 GitHub 并启用 Pages
# ============================================================
# 用法：
#   1) 在本机打开终端，进入 /workspace 目录
#   2) 复制粘贴并执行：
#
#      bash push_to_github.sh
#
#   3) 当提示输入 Personal Access Token 时，粘贴你在
#      https://github.com/settings/tokens 生成的 token（需 repo 权限）
#
# 或者如果你已经用 ssh 登录过 GitHub，脚本会自动使用 ssh。
# ============================================================

set -e

NEW_REPO_NAME="order-manager"   # 你也可以改成别的名字
NEW_REPO_DESC="效果图代画订单管理系统（第二代，含 Telegram 通知）"
GITHUB_USER="${GITHUB_USER:-ZTKyo}"

cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

echo "==> 当前目录: $ROOT_DIR"
echo "==> 目标仓库: $GITHUB_USER/$NEW_REPO_NAME"
echo ""

# -------- 1) 检查 git --------
if ! command -v git >/dev/null 2>&1; then
    echo "[ERROR] 请先安装 git"
    exit 1
fi

# -------- 2) 如果已存在 .git，直接用；否则重新 init --------
if [ ! -d ".git" ]; then
    git init
    git checkout -b main
fi

# 确保有邮箱/用户名（commit 必须）
git config user.email || git config user.email "auto@$NEW_REPO_NAME.local"
git config user.name  || git config user.name "$USER"

# -------- 3) 问用户要 Personal Access Token（或使用 ssh） --------
echo ""
echo "请选择认证方式："
echo "  [1] GitHub Personal Access Token（推荐 — https://github.com/settings/tokens 生成一个带 repo 权限的 token）"
echo "  [2] SSH（如果你本机已经 ssh-keygen 并在 GitHub 上传了公钥）"
echo "  [3] 我自己推送，只生成本地 git 仓库"
read -rp "输入 1 / 2 / 3 回车：" choice

REPO_URL=""
case "$choice" in
  1)
    read -rp "粘贴你的 GitHub Token: " TOKEN
    if [ -z "$TOKEN" ]; then echo "[ERROR] token 为空"; exit 1; fi
    TOKEN="${TOKEN// /}"
    REPO_URL="https://$TOKEN@github.com/$GITHUB_USER/$NEW_REPO_NAME.git"
    ;;
  2)
    REPO_URL="git@github.com:$GITHUB_USER/$NEW_REPO_NAME.git"
    ;;
  3)
    echo ""
    echo "==> 本地仓库就绪。你自己推送时执行："
    echo "    gh repo create $NEW_REPO_NAME --public --source=. --push"
    echo "    或："
    echo "    git remote add origin https://github.com/$GITHUB_USER/$NEW_REPO_NAME.git"
    echo "    git push -u origin main"
    echo ""
    echo "==> 手动创建仓库后，去 Settings -> Pages -> Branch: main, / (root) -> Save"
    echo "    即可得到：https://$GITHUB_USER.github.io/$NEW_REPO_NAME/"
    ;;
  *)
    echo "[ERROR] 无效选择"
    exit 1
    ;;
esac

# -------- 4) 提交所有文件 --------
git add -A
git commit -m "feat: 第二代订单管理系统（Firebase + Telegram 通知）" || echo "(commit 无变化，跳过)"

# -------- 5) 若需要推送则设置 remote 并 push --------
if [ -n "$REPO_URL" ]; then
    if git remote get-url origin >/dev/null 2>&1; then
        echo "==> 更新 origin 指向新仓库"
        git remote set-url origin "$REPO_URL"
    else
        git remote add origin "$REPO_URL"
    fi

    echo ""
    echo "==> 推送代码到 GitHub ..."
    if ! git push -u origin main; then
        echo ""
        echo "[提示] 如果报 'remote: Repository not found'"
        echo "    — 说明仓库尚未创建，请先去 https://github.com/new 新建名为 $NEW_REPO_NAME 的仓库（public），再重试本脚本。"
        echo "    也可以安装 gh CLI 后执行：gh repo create $NEW_REPO_NAME --public --source=. --push"
        exit 1
    fi
    echo ""
    echo "==> 代码推送完成！"
    echo ""
    echo "----------------------------------------------------------------------"
    echo "🎉 下一步："
    echo "  1) 打开 https://github.com/$GITHUB_USER/$NEW_REPO_NAME/settings/pages"
    echo "     Source: Branch = main, Folder = / (root)"
    echo "     Save 后约 1-2 分钟生效"
    echo "  2) 访问新链接：https://$GITHUB_USER.github.io/$NEW_REPO_NAME/"
    echo "----------------------------------------------------------------------"
fi
