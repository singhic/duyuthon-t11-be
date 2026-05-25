#!/bin/bash
# Supabase Cron 모니터링 스크립트
# 30분마다 Cron 실행 로그 확인

PROJECT_REF="hygsrrmoawezonahnljn"
JOBNAME="send-medication-reminders-every-30-min"

# SQL 쿼리 (README.md에서 추천하는 모니터링 SQL)
cat > /tmp/cron_monitoring.sql <<'EOF'
-- 최근 10회 Cron 실행 로그
SELECT
  d.jobid,
  j.jobname,
  d.status,
  d.start_time AT TIME ZONE 'Asia/Seoul' as start_time_kst,
  d.end_time AT TIME ZONE 'Asia/Seoul' as end_time_kst,
  EXTRACT(EPOCH FROM (d.end_time - d.start_time)) as duration_sec,
  d.return_message
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = 'send-medication-reminders-every-30-min'
ORDER BY d.start_time DESC
LIMIT 10;
EOF

echo "📊 Supabase Cron 모니터링"
echo "프로젝트: $PROJECT_REF"
echo "작업: $JOBNAME"
echo ""
echo "Supabase SQL Editor에서 다음 SQL을 실행하세요:"
cat /tmp/cron_monitoring.sql
