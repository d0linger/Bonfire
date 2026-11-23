ALTER TABLE originals ADD COLUMN previous_number bigint REFERENCES originals(number);
CREATE UNIQUE INDEX originals_one_correction ON originals(previous_number) WHERE previous_number IS NOT NULL;
