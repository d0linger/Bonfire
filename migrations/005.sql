CREATE TABLE journal_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event uuid NOT NULL REFERENCES events,
 target text NOT NULL, operation uuid, revision bigint NOT NULL, direction smallint NOT NULL CHECK(direction IN (-1,1)),
 kind text NOT NULL, data jsonb NOT NULL, actor text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO journal_history(event,target,revision,direction,kind,data,actor)
 SELECT e.event,e.id,e.revision,1,e.kind,e.data,d.username FROM entries e JOIN devices d ON d.id=e.device
 WHERE e.kind IN ('income','expense','transfer','payment','donation','reimbursement','card','fee','payout','presale','supply','skim','return');

