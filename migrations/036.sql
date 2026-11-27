ALTER TABLE fire_year_counts
 ADD COLUMN opening_source_year uuid REFERENCES fiscal_years(id),
 ADD COLUMN opening_source_revision integer,
 ADD CONSTRAINT opening_provenance_complete CHECK (
   (opening_source_year IS NULL AND opening_source_revision IS NULL) OR
   (opening_source_year IS NOT NULL AND opening_source_year <> year
    AND opening_source_revision IS NOT NULL AND opening_source_revision > 0)
 );
CREATE INDEX fire_year_counts_opening_source ON fire_year_counts(opening_source_year)
 WHERE opening_source_year IS NOT NULL;
