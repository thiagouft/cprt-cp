"""Extrai do Dash.xlsx a base (aba Banco de dados) e os valores JÁ CALCULADOS pelo Excel (abas Cálculos / Cálculos AP).
Uso:  python -X utf8 tests/export_dash.py [caminho/Dash.xlsx]   ->  tests/fixtures/dash-golden.json
O JSON contém dados reais (placas, motoristas) e por isso fica fora do git (ver .gitignore)."""
import sys, json, datetime, warnings, os
warnings.filterwarnings('ignore')
import openpyxl

src = sys.argv[1] if len(sys.argv) > 1 else 'Dash.xlsx'
wb = openpyxl.load_workbook(src, data_only=True)

def cel(v):
    if isinstance(v, datetime.datetime): return v.strftime('%Y-%m-%d') + ('T' + v.strftime('%H:%M') if (v.hour or v.minute) else '')
    if isinstance(v, datetime.time): return v.strftime('%H:%M')
    return v

bd = wb['Banco de dados']
header = [c.value for c in bd[1]]
rows = [[cel(c) for c in r] for r in bd.iter_rows(min_row=2, values_only=False) if r[0].value]
rows = [[cel(c.value) if hasattr(c, 'value') else c for c in r] for r in bd.iter_rows(min_row=2) if r[0].value]

def col(ws, c, r1, r2): return [cel(ws.cell(r, c).value) for r in range(r1, r2 + 1)]
def blk(ws, r1, r2, c1, c2): return [[cel(ws.cell(r, c).value) for c in range(c1, c2 + 1)] for r in range(r1, r2 + 1)]

C, A = wb['Cálculos'], wb['Cálculos AP']
g = {
  'hoje': cel(wb['Painel']['V2'].value),
  'painel': {
    'janela': [cel(C['B8'].value), cel(C['B9'].value)],
    'indicadores': {C.cell(r, 7).value: C.cell(r, 8).value for r in range(2, 13)},
    'dias': blk(C, 2, 8, 10, 12),
    'patios': blk(C, 2, 3, 14, 15),
    'bitolas': blk(C, 2, 11, 17, 24),
    'controladores': blk(C, 2, 6, 26, 27),
    'ultimos15': blk(C, 2, 16, 29, 40),
  },
  'aco': {
    'janela': [cel(A['B13'].value), cel(A['B14'].value)],
    'indicadores': {A.cell(r, 7).value: A.cell(r, 8).value for r in range(2, 16)},
    'elementos': blk(A, 2, 9, 10, 11),
    'desenhos': blk(A, 2, 11, 13, 14),
    'bitolas': blk(A, 2, 9, 16, 19),
    'dias': blk(A, 2, 8, 21, 23),
    'matriz': blk(A, 2, 10, 25, 34),
    'resumoDesenhos': blk(A, 2, 26, 36, 49),
    'ultimas25': blk(A, 2, 26, 50, 63),
    'onde': blk(A, 2, 10, 75, 84),
    'localPadronizado': col(A, 73, 2, 401),
  },
}
os.makedirs('tests/fixtures', exist_ok=True)
json.dump({'header': header, 'rows': rows, 'golden': g}, open('tests/fixtures/dash-golden.json', 'w', encoding='utf-8'), ensure_ascii=False, default=str)
print('linhas', len(rows), '| BU[0..2]=', g['aco']['localPadronizado'][:3], '| matriz[0]=', g['aco']['matriz'][0])
