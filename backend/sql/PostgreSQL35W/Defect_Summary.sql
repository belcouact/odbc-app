SELECT DISTINCT
    p.pieceid,
    p.name AS piece_name,
    to_char(to_timestamp(p.starttimems / 1000.0), 'YYYY-MM-DD HH24:MI:SS') AS start_time,
    ROUND(CAST((p.stopmd - p.startmd) / 1000.0 AS NUMERIC), 1) AS length_meters,
    c.name AS class_name,
    j.recipe AS job_recipe,
    l.name AS layer_name,
    COUNT(d.defectid) AS defect_count
FROM pieces p
JOIN frames f ON p.pieceid = f.pieceid
JOIN jobs j ON j.jobid = f.jobid
JOIN defectsinframes dif ON f.frameid = dif.frameid
JOIN defects d ON dif.defectid = d.defectid
JOIN classes c ON d.classid = c.classid
JOIN severities s ON d.severityid = s.severityid
LEFT JOIN layers l ON d.layerid = l.layerid
WHERE 1 = 1
  {}
  -- AND p.name LIKE '50TT test-004'
  -- AND p.flags = 0
GROUP BY p.pieceid, p.name, c.name, l.name, j.recipe
ORDER BY p.pieceid, defect_count DESC;
