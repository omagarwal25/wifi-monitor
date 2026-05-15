.PHONY: install cron update logs errors status clean

install:
	sudo apt update && sudo apt install -y python3-pip git sqlite3
	pip3 install requests python-dotenv
	cp -n .env.example .env
	@echo "-----"
	@echo "Edit .env with your API_URL and API_KEY, then run: make cron"
	@echo "-----"

cron:
	(crontab -l 2>/dev/null; echo "* * * * * /usr/bin/python3 $(PWD)/monitor.py >> $(PWD)/cron.log 2>&1") | crontab -
	@echo "Cron job installed."

update:
	git pull
	pip3 install -r requirements.txt

logs:
	tail -f cron.log

errors:
	tail -f errors.log

status:
	@echo "=== Cron ===" && crontab -l
	@echo "=== Last 5 rows ===" && sqlite3 metrics.db \
		"SELECT measured_at, router_reachable, external_reachable, router_latency_ms, external_latency_ms FROM metrics ORDER BY id DESC LIMIT 5;"
	@echo "=== Unpushed rows ===" && sqlite3 metrics.db \
		"SELECT COUNT(*) FROM metrics WHERE pushed = 0;"

clean:
	rm -f metrics.db cron.log errors.log
