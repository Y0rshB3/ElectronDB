# ************************************************************
# Exported by TablePlus (synthetic sample)
# Database: tareas
# ************************************************************

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `tareas`;
CREATE TABLE `tareas` (
  `id` int NOT NULL,
  `hecho` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `tareas` (`id`, `hecho`) VALUES
	(1, 0),
	(2, 1);
