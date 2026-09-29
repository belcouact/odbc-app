SELECT DISTINCT
  s.G_WO as 'WO',
  s.G_WOL as 'WOL',
  s.G_ITEM as 'ITEM',
  s.G_MAIN_GROUP as 'MAIN_GROUP',
  s.DESCRIPTION as 'PRODUCT_DESCRIPTION',
  s.G_MAN_DATE AS 'Manuf. Date',
  s.g_lsn AS 'LSN',
  ROUND(s.G_LSN_QTY, 2) AS 'LSN Qty',
  s.G_ROLL_INDEX AS 'LSN #',
  g_qsc.g_fault_code as 'FAULT_CODE',
  g_fault_codes.US_DESCRIPTION as 'FAULT_CODE_DESCRIPTION'
FROM
  SAMPLE s
  INNER JOIN G_QSC g_qsc ON s.g_lsn = g_qsc.g_lsn
  INNER JOIN g_fault_codes g_fault_codes ON g_fault_codes.name = g_qsc.g_fault_code
  INNER JOIN versions v ON g_fault_codes.name = v.name
  AND g_fault_codes.version = v.version
WHERE
  s.template IN ('VS_LSN', 'VS_LSN_RM')
  AND right(s.G_ITEM, 1) <> 'Z'
  AND left(s.G_WO, 2) <> 'RM'
  AND s.status = 'R'
  AND g_qsc.code_number = 300
  {}
ORDER BY
  s.G_WOL,
  s.g_lsn