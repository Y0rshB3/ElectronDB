-- Adminer 4.8.1 MySQL 8.4.0 dump

SET NAMES utf8;
SET time_zone = '+00:00';
SET foreign_key_checks = 0;
SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `notas`;
CREATE TABLE `notas` (
  `id` int NOT NULL AUTO_INCREMENT,
  `texto` text NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO `notas` (`id`, `texto`) VALUES
(1,	'primera'),
(2,	'con \'comillas\' y #almohadilla');

DELIMITER ;;

CREATE TRIGGER `notas_bi` BEFORE INSERT ON `notas` FOR EACH ROW
SET NEW.texto = TRIM(NEW.texto);;

DELIMITER ;

-- 2026-10-07 12:00:00
