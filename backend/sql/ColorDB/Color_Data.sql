SELECT *
FROM (
    SELECT
        SDATE AS [DATE],
        SNAME AS [NAME],
        STSV_1 AS L,
        STSV_2 AS a,
        STSV_3 AS b
    FROM STANDARDS_GROUP

    UNION ALL

    SELECT
        DDATE AS [DATE],
        DNAME AS [NAME],
        DTSV_1 AS L,
        DTSV_2 AS a,
        DTSV_3 AS b
    FROM DATA_GROUP
) AS COLOR_DATA
WHERE 1 = 1
{}
