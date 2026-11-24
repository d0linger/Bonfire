-- Legacy closings froze the complete date range across the installation.
-- Store the immutable scope for new closings in a fiscal year.
ALTER TABLE period_closures ADD COLUMN fiscal_year uuid REFERENCES fiscal_years;
