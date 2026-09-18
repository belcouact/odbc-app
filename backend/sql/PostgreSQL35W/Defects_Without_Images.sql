SELECT
   d.defectid,
   d.defectindex,
   p.pieceid,
   p.name AS piece_name,
   ROUND(CAST((p.stopmd - p.startmd) / 1000.0 AS NUMERIC), 1) AS length_meters,
   c.name AS class_name,
   j.name,
   j.recipe AS job_recipe,
   s.name AS severity_name,
   l.name AS layer_name,
   d.flags AS defect_flag,
   ROUND(feat.cdBoxCenter::numeric, 1) AS "Cd_loc (mm)",
   ROUND(feat.mdBoxCenter::numeric / 1000, 1) AS "Md_loc (m)",
   ROUND(feat.def_width::numeric, 1) AS "width (mm)",
   ROUND(feat.def_length::numeric, 1) AS "Length (mm)",
   ROUND(feat.def_size::numeric, 1) AS "Size (mm)"
FROM pieces p
JOIN frames f ON f.pieceid = p.pieceid
JOIN jobs j ON j.jobid = f.jobid
JOIN defectsinframes dif ON dif.frameid = f.frameid
JOIN defects d ON d.defectid = dif.defectid
JOIN severities s ON d.severityid = s.severityid
JOIN classes c ON d.classid = c.classid
LEFT JOIN layers l ON d.layerid = l.layerid
-- getFeatures executes once per defect through this lateral join.
LEFT JOIN LATERAL (
   SELECT
       MAX(CASE WHEN name = 'cdBoxCenter' THEN value END) AS cdBoxCenter,
       MAX(CASE WHEN name = 'mdBoxCenter' THEN value END) AS mdBoxCenter,
       MAX(CASE WHEN name = 'width' THEN value END) AS def_width,
       MAX(CASE WHEN name = 'length' THEN value END) AS def_length,
       MAX(CASE WHEN name = 'size' THEN value END) AS def_size
   FROM getFeatures(d.defectid)
) feat ON true
WHERE 1 = 1
  {}
  -- AND p.name = '50TT test-004'
  -- AND p.flags = 0
  -- AND c.name IN ('点状_Bottom')
  -- AND l.name IN ('Top', 'Bulk', 'Bottom')
ORDER BY p.name, d.defectid;
