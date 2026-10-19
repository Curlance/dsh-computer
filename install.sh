#!/usr/bin/env bash
# dsh-computer-use 0.4.0 —— DSH 0.2.1-rc.2（desktop profile）安装脚本
#
# 安装层（不修改 profile 的 package.json / cordis.patch.yml）：
#   1) 把插件包链接进 profile 的 node_modules（宿主按 profile 解析插件名与 peer）
#   2) 把 preset-computer-use（preset.patch.yml）追加到 HOME 层
#      $DSH_HOME/cordis.patch.yml，并加起止标记，便于卸载
#
# 用法: ./install.sh [--dry-run] [--profile desktop]
# 卸载: ./uninstall.sh [--profile desktop]
set -euo pipefail

DRY_RUN=0
PROFILE=desktop
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --profile) shift; PROFILE="${1:-desktop}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
SRC="$(cd "$(dirname "$0")" && pwd)"
NM_DIR="$DSH_HOME/profiles/$PROFILE/node_modules"
PATCH="$DSH_HOME/cordis.patch.yml"
MARK_BEGIN='# >>> dsh-computer-use (HOME layer preset; managed by install.sh)'
MARK_END='# <<< dsh-computer-use'

echo "== dsh-computer-use 0.4.0 install =="
echo "  DSH_HOME : $DSH_HOME"
echo "  profile  : $PROFILE"
echo "  source   : $SRC"

[ -d "$NM_DIR" ] || { echo "错误: 未找到 profile node_modules: $NM_DIR" >&2; exit 1; }
[ -f "$SRC/preset.patch.yml" ] || { echo "错误: 缺少 preset.patch.yml" >&2; exit 1; }

# 1) 链接插件包到 profile node_modules（优先 junction，避免 Windows 符号链接权限问题）
LINK="$NM_DIR/dsh-computer-use"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] link $SRC -> $LINK"
else
  rm -rf "$LINK" 2>/dev/null || true
  if ! cmd.exe //c mklink //J "$(cygpath -w "$LINK" 2>/dev/null || echo "$LINK")" "$(cygpath -w "$SRC" 2>/dev/null || echo "$SRC")" >/dev/null 2>&1; then
    ln -sfn "$SRC" "$LINK"
  fi
  [ -e "$LINK" ] || { echo "错误: 插件链接创建失败: $LINK" >&2; exit 1; }
  echo "  [ok] 插件已链接: $LINK"
fi

# 2) HOME 层注册 preset（带起止标记，幂等）
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] append preset-computer-use -> $PATCH"
else
  touch "$PATCH"
  if grep -qF "$MARK_BEGIN" "$PATCH"; then
    echo "  [ok] HOME patch 已含 dsh-computer-use 区块（跳过；如需更新先 uninstall）"
  else
    {
      printf '\n%s\n' "$MARK_BEGIN"
      cat "$SRC/preset.patch.yml"
      printf '%s\n' "$MARK_END"
    } >> "$PATCH"
    echo "  [ok] 已追加 preset-computer-use -> $PATCH"
  fi
fi

echo "== 完成。重启 DeepSeek Harness 桌面端后，新建会话选择 Computer Use 预设 =="
if [ "$DRY_RUN" = 1 ]; then
  echo "== 预演结束（未写入任何文件）=="
fi
