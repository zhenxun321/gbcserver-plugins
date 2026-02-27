# -*- coding: utf-8 -*-
#  getUuid.py
#  算法源自：https://ghproxy.net/https://raw.githubusercontent.com/janblaesi/mc-uuid-converter/master/convert.py

import sys
import uuid


class NULL_NAMESPACE:  # 建立空域命名空间
    """Replicate Java UUID.nameUUIDfromBytes behavior."""
    bytes = b''


def name_to_offline_uuid(name):  # 使用空域命名空间生成uuid
    """Return the *offline* UUID of a player name."""
    return uuid.uuid3(NULL_NAMESPACE, f'OfflinePlayer:{name}')


def main(argv):
    if len(argv) < 2:
        print('用法: python3 getUuid.py <玩家名>', file=sys.stderr)
        return 1

    # 允许玩家名包含空格，兼容被 shell 拆分为多个参数的输入
    player_name = ' '.join(argv[1:]).strip()
    if not player_name:
        print('错误: 玩家名不能为空', file=sys.stderr)
        return 1

    print(name_to_offline_uuid(player_name))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
