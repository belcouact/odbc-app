SELECT * FROM <> db
WHERE db.WOL NOT LIKE 'EMPTY%'
  {}
ORDER BY
    db.Date_Time,
    db.DEVICE_NUM;
