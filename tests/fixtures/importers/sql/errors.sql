-- Synthetic dump with mistakes on known lines (for line-number tests)
CREATE TABLE t_ok (id INT PRIMARY KEY);
INSERT INTO t_ok VALUES (1);

INSERT INTO t_missing VALUES (2);
INSERT INTO t_ok VALUES (3);
THIS IS NOT SQL;
INSERT INTO t_ok VALUES (4);
