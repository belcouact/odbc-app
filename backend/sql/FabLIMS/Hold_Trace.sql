SELECT
  g_lsn.G_WO as 'WO',
  g_lsn.G_WOL as 'WOL',
  g_lsn.G_ITEM as 'ITEM',
  s.G_MAIN_GROUP as 'MAIN_GROUP',
  gmp.DESCRIPTION AS 'MAIN_GROUP_DESCRIPTION',
  s.DESCRIPTION as 'PRODUCT_DESCRIPTION',
  g_lsn.G_MAN_DATE AS 'Manuf. Date',
  g_lsn.NAME AS 'LSN',
  ROUND(g_lsn.G_LSN_QTY, 2) AS 'LSN Qty',
  g_lsn.G_ROLL_INDEX AS 'LSN #',
  g_lsn.HOLD_CODE as 'HOLD_CODE',
  g_lsn.HOLD_DESC as 'HOLD_DESC',
  g_lsn.FAULT_DESC as 'FAULT_DESC'
FROM
  G_LSN g_lsn
  LEFT JOIN SAMPLE s ON g_lsn.SAMPLE_NUMBER = s.SAMPLE_NUMBER
  LEFT JOIN G_MAIN_GROUPS gmp ON gmp.NAME = s.G_MAIN_GROUP
WHERE
  g_lsn.HOLD_CODE IS NOT NULL
  AND left(s.G_MAIN_GROUP, 4) <> 'FXXX'
  AND left(g_lsn.G_WO, 2) <> 'RM'
  
  {}
ORDER BY
  g_lsn.G_WOL,
  g_lsn.NAME