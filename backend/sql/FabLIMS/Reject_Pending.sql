SELECT
  g_lsn.G_WOL AS WOL,
  g_lsn.G_ITEM AS Item,
  s.G_MAIN_GROUP AS 'Main Group',
  s.DESCRIPTION AS 'Product Description',
  g_lsn.NAME AS 'LSN',
  g_lsn.G_MAN_DATE AS 'Manuf Date',
  g_lsn.DUE_DATE,
  g_lsn.G_ROLL_INDEX AS 'Roll #',
  ROUND(g_lsn.G_LSN_QTY, 2) AS 'LSN Qty',
  g_lsn.HOLD_CODE,
  g_lsn.HOLD_DESC,
  g_lsn.FAULT_DESC,
  abc.formatted_entry AS 'QA_COMMENT'
FROM
  G_LSN g_lsn
  LEFT JOIN SAMPLE s ON g_lsn.SAMPLE_NUMBER = s.SAMPLE_NUMBER
  LEFT JOIN (
    SELECT
      t.sample_number,
      t.status,
      r.formatted_entry
    FROM
      test t
      LEFT JOIN result r ON t.test_number = r.test_number
    WHERE
      t.analysis = 'QSC_QA'
      AND t.status <> 'A'
      AND r.name = 'Fault Description'
  ) abc ON abc.SAMPLE_NUMBER = g_lsn.SAMPLE_NUMBER
WHERE
  g_lsn.HOLD_CODE <> 'Q99'
  AND s.status NOT IN ('A', 'R', 'X')
  AND s.G_MAIN_GROUP NOT LIKE 'FXXX%'
  AND g_lsn.G_ITEM NOT LIKE '%Z'
  AND g_lsn.G_WO NOT LIKE 'RM%'
  AND g_lsn.G_LOT_STS IN ('Q', 'A')
  {}
ORDER BY
  g_lsn.G_ITEM,
  g_lsn.G_WOL,
  g_lsn.NAME