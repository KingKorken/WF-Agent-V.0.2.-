# File Skills (Layer 1 — Skill/API)

Python scripts that provide direct programmatic file access.
The agent calls these via `shell/exec` commands — no UI automation needed.

## Excel Skill
- `python3 excel-skill.py info <file>` — headers, dimensions, sheet names
- `python3 excel-skill.py read <file>` — full sheet as JSON with headers
- `python3 excel-skill.py search <file> <query>` — find rows matching a value
- `python3 excel-skill.py read-cell <file> <cell>` — single cell
- `python3 excel-skill.py write-cell <file> <cell> <value>` — write a cell

## Word Skill
- `python3 word-skill.py info <file>` — paragraphs, tables, placeholders
- `python3 word-skill.py read <file>` — all text content
- `python3 word-skill.py replace-batch <file> --replacements '<json>'` — fill template
- `python3 word-skill.py fill-table <file> --table-index <n> --data '<json>'` — fill table rows

## Requirements
pip3 install openpyxl python-docx
