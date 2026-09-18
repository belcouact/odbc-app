SELECT
   d.defectid,
   d.defectindex,
   p.pieceid,
   p.name AS piece_name,
   to_char(to_timestamp(p.starttimems / 1000.0), 'YYYY-MM-DD HH24:MI:SS') AS start_time,
   ROUND(CAST((p.stopcd - p.startcd) AS NUMERIC), 1) AS cd_mm,
   ROUND(CAST((p.stopmd - p.startmd) / 1000.0 AS NUMERIC), 1) AS md_m,
   c.name AS class_name,
   j.name AS job_name,
   j.recipe AS job_recipe,
   s.name AS severity_name,
   l.name AS layer_name,
   d.flags AS defect_flag,
   ROUND(feat.cdBoxCenter::numeric, 1) AS "Cd_loc (mm)",
   ROUND(feat.mdBoxCenter::numeric / 1000, 1) AS "Md_loc (m)",
   ROUND(feat.def_width::numeric, 1) AS "width (mm)",
   ROUND(feat.def_length::numeric, 1) AS "Length (mm)",
   ROUND(feat.def_area::numeric, 1) AS "Area (mm2)",
   img_pivot.RRDD_image,
   img_pivot.RRDH_image,
   img_pivot.RRCD_image
FROM pieces p
JOIN frames f ON f.pieceid = p.pieceid
JOIN jobs j ON j.jobid = f.jobid
JOIN defectsinframes dif ON dif.frameid = f.frameid
JOIN defects d ON d.defectid = dif.defectid
JOIN severities s ON d.severityid = s.severityid
JOIN classes c ON d.classid = c.classid
LEFT JOIN layers l ON d.layerid = l.layerid
LEFT JOIN LATERAL (
   SELECT
       MAX(CASE WHEN name = 'cdBoxCenter' THEN value END) AS cdBoxCenter,
       MAX(CASE WHEN name = 'mdBoxCenter' THEN value END) AS mdBoxCenter,
       MAX(CASE WHEN name = 'width' THEN value END) AS def_width,
       MAX(CASE WHEN name = 'length' THEN value END) AS def_length,
       MAX(CASE WHEN name = 'area' THEN value END) AS def_area
   FROM getFeatures(d.defectid)
) feat ON true
LEFT JOIN LATERAL (
   SELECT
       MAX(CASE WHEN ch.channelkey = 'RRDD' THEN encode(di.imagebuffer, 'base64') END) AS RRDD_image,
       MAX(CASE WHEN ch.channelkey = 'RRDH' THEN encode(di.imagebuffer, 'base64') END) AS RRDH_image,
       MAX(CASE WHEN ch.channelkey = 'RRCD' THEN encode(di.imagebuffer, 'base64') END) AS RRCD_image
       -- Add more channel columns here if needed.
   FROM defectimages di
   INNER JOIN channels ch ON di.channelid = ch.channelid
   WHERE di.defectid = d.defectid
) img_pivot ON true
WHERE 1 = 1
  {}
  -- AND j.name = '09174332AA'
  -- AND p.name = '50TT test-004'
  -- AND p.flags = 0
  -- AND c.name IN ('点状_Bottom')
ORDER BY j.name, d.defectid;
