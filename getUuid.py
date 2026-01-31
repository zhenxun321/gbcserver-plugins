# -*- coding: utf-8 -*-
#  getUuid.py
#  算法源自：https://ghproxy.net/https://raw.githubusercontent.com/janblaesi/mc-uuid-converter/master/convert.py

import uuid # 引入文件
import sys

class NULL_NAMESPACE: #建立空域命名空间
    """This garbage is needed to replicate the behavior of the UUID.nameUUIDfromBytes function present in Java."""
    bytes = b''

def name_to_offline_uuid(name): # 使用空域命名空间生成uuid
    """Return the *offline* UUID of a player name"""
    return uuid.uuid3(NULL_NAMESPACE, 'OfflinePlayer:%s' % name)

if __name__ == '__main__': #别问我为什么只能处理没空格的，问就是试过，uuid完全对不上
    print(name_to_offline_uuid(sys.argv[1]))