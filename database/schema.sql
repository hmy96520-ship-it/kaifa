CREATE DATABASE IF NOT EXISTS studio_hr
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE studio_hr;

CREATE TABLE IF NOT EXISTS job_post (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(100) NOT NULL,
  must_skills JSON NOT NULL,
  nice_skills JSON NOT NULL,
  responsibilities TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS question_bank (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_post_id BIGINT NOT NULL,
  category VARCHAR(30) NOT NULL,
  question_text TEXT NOT NULL,
  focus TEXT NOT NULL,
  rubric TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_question_job_post FOREIGN KEY (job_post_id) REFERENCES job_post(id) ON DELETE CASCADE,
  INDEX idx_question_job_post (job_post_id)
);

CREATE TABLE IF NOT EXISTS interview_session (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_post_id BIGINT NOT NULL,
  candidate_name VARCHAR(80) NOT NULL,
  interviewer_name VARCHAR(80) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL,
  CONSTRAINT fk_interview_job_post FOREIGN KEY (job_post_id) REFERENCES job_post(id),
  INDEX idx_interview_job_post (job_post_id)
);

CREATE TABLE IF NOT EXISTS transcript_segment (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  interview_session_id BIGINT NOT NULL,
  speaker VARCHAR(20) NOT NULL DEFAULT 'candidate',
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transcript_session FOREIGN KEY (interview_session_id) REFERENCES interview_session(id) ON DELETE CASCADE,
  INDEX idx_transcript_session (interview_session_id)
);

CREATE TABLE IF NOT EXISTS ai_assessment (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  interview_session_id BIGINT NOT NULL,
  total_score INT NOT NULL,
  suggestion VARCHAR(30) NOT NULL,
  coverage_score INT NOT NULL,
  depth_score INT NOT NULL,
  communication_score INT NOT NULL,
  risk_score INT NOT NULL,
  summary TEXT NOT NULL,
  raw_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_assessment_session FOREIGN KEY (interview_session_id) REFERENCES interview_session(id) ON DELETE CASCADE,
  UNIQUE KEY uk_assessment_session (interview_session_id)
);
