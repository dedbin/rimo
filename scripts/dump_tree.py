#!/usr/bin/env python3
import os
import json
import fnmatch
import argparse

DEFAULT_IGNORE = [
    ".git",
    "node_modules",
    ".next",
    "__pycache__",
    "*.pyc",
    "*.env*",
    "dist",
    "build",
]


def should_ignore(name: str, ignore_patterns: list[str]) -> bool:
    for pat in ignore_patterns:
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def build_tree(path: str, ignore_patterns: list[str]) -> dict:
    """
    Рекурсивно обходит директорию и строит вложенный словарь:
    - ключ — имя файла или папки
    - значение — None для файла, или такой же словарь для папки

    Пропускает файлы/папки, подходящие под ignore_patterns.
    """
    tree: dict = {}
    try:
        for name in sorted(os.listdir(path)):
            if should_ignore(name, ignore_patterns):
                continue

            full = os.path.join(path, name)
            if os.path.isdir(full):
                subtree = build_tree(full, ignore_patterns)
                tree[name] = subtree
            else:
                tree[name] = None
    except PermissionError:
        pass
    return tree


def run():
    parser = argparse.ArgumentParser(
        description="Выгружает структуру папок в JSON с опцией игнорировать паттерны."
    )
    parser.add_argument(
        "path",
        nargs="?",
        default='.',
        help="Корневая папка проекта (default: .)"
    )
    parser.add_argument(
        "--ignore",
        nargs="+",
        metavar="PATTERN",
        help="Паттерны для игнорирования (glob), например .next node_modules *.pyc"
    )
    parser.add_argument(
        "--out",
        "-o",
        metavar="FILE",
        help="Куда сохранить результат: .json (если не указан — печать в консоль)"
    )
    args = parser.parse_args()

    root = os.path.abspath(args.path)
    ignore = args.ignore if args.ignore else DEFAULT_IGNORE

    tree = { os.path.basename(root): build_tree(root, ignore) }

    output = json.dumps(tree, ensure_ascii=False, indent=2)

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"✓ Структура сохранена в {args.out}")
    else:
        print(output)


if __name__ == '__main__':
    run()
