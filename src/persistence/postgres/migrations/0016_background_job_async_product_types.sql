ALTER TABLE background_job DROP CONSTRAINT IF EXISTS background_job_type_check;
ALTER TABLE background_job ADD CONSTRAINT background_job_type_check CHECK (type IN ('import_pdf', 'export_pdf', 'rebuild_index', 'long_generation', 'parse_document', 'import_resume_file', 'import_resume_text', 'export_resume_html', 'export_resume_pdf'));
