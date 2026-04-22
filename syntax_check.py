#!/usr/bin/env python3
"""
UNITY Bot — JavaScript Syntax Checker
Checks all .js files in src/commands/ for syntax errors using Node.js
"""
import subprocess
import sys
import os

def check_syntax(file_path):
    try:
        result = subprocess.run(
            ['node', '--check', file_path],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return True, None
        else:
            err = result.stderr.strip()
            return False, err
    except FileNotFoundError:
        return None, 'node not found — please install Node.js'
    except subprocess.TimeoutExpired:
        return None, 'timeout'
    except Exception as e:
        return None, str(e)

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # Search relative to this script's location (project root)
    search_dirs = [
        os.path.join(script_dir, 'src', 'commands'),
        os.path.join(script_dir, '..', 'src', 'commands'),
        'src/commands',
    ]
    cmd_dir = None
    for d in search_dirs:
        if os.path.isdir(d):
            cmd_dir = os.path.abspath(d)
            break

    if not cmd_dir:
        print('ERROR: Could not find src/commands directory.')
        print('Run this script from the project root.')
        sys.exit(1)

    print(f'Checking: {cmd_dir}\n')

    js_files = sorted([
        os.path.join(cmd_dir, f)
        for f in os.listdir(cmd_dir)
        if f.endswith('.js')
    ])

    if not js_files:
        print('No .js files found.')
        sys.exit(0)

    ok_count = 0
    err_count = 0
    errors = []

    for fpath in js_files:
        fname = os.path.basename(fpath)
        ok, err = check_syntax(fpath)
        if ok is None:
            print(f'  SKIP  {fname}  ({err})')
        elif ok:
            print(f'  ✅ OK   {fname}')
            ok_count += 1
        else:
            print(f'  ❌ ERR  {fname}')
            errors.append((fname, err))
            err_count += 1

    print(f'\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    print(f'Results: {ok_count} OK  |  {err_count} ERRORS')
    print(f'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    if errors:
        print('\nERROR DETAILS:')
        for fname, err in errors:
            print(f'\n--- {fname} ---')
            print(err)
        sys.exit(1)
    else:
        print('\nAll files passed syntax check!')
        sys.exit(0)

if __name__ == '__main__':
    main()
