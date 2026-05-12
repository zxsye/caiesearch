# SchSrch

![demo video](readme_video.gif)

[![Known Vulnerabilities](https://snyk.io/test/github/micromaomao/schsrch/badge.svg)](https://snyk.io/test/github/micromaomao/schsrch)
[![MIT Licence](https://badges.frapsoft.com/os/mit/mit.svg?v=103)](https://opensource.org/licenses/mit-license.php)

---

## Ready-to-run docker image

`docker pull ghcr.io/micromaomao/schsrch`

Environment variables needed: (i.e. docker run -e xxx=xxx -e&hellip; maowtm/schsrch)

- MONGODB=mongodb://*&lt;your-mongo-server&gt;*/schsrch
- ES=*&lt;your-elasticsearch-server&gt;*:9200
- SITE\_ORIGIN=http://localhost (depend on you)

For a possible developmental set-up, see [./docker-compose-example.yml](./docker-compose-example.yml).

----

## Maintenance & Enrichment

### Question-Level Topic Tagging
The project uses Gemini 3.1 Flash-Lite to automatically categorize questions into syllabus topics.

To run the tagging script:
```bash
docker exec -it -e GEMINI_API_KEY=$GEMINI_API_KEY schsrch-www node doLinkTopics.bin.js <subject_code> [limit] [year] [paper] [--force]
```

- **subject_code**: The 4-digit CIE subject code (e.g., `9709`, `0625`).
- **limit**: Number of papers to process (defaults to 5).
- **year**: (Optional) Filter by year (e.g., `23`) or range (e.g., `20-23`).
- **paper**: (Optional) Filter by paper (e.g., `1`), variant (e.g., `13`), or list (e.g., `1,2,11`).
- **--force**: (Optional) Overwrite existing topic tags.

> [!NOTE]
> Ensure `GEMINI_API_KEY` is defined in your `docker-compose.yml` or environment.

----

<a href="https://www.browserstack.com/"><img alt="BrowserStack logo" src="https://bstacksupport.zendesk.com/attachments/token/bueUNYiYxIt9MAgcZtTTLFS59/?name=Logo-01.svg" width="270"></a>

BrowserStack supported this project by offering me free access to a variety of real iPhone / Mac devices for testing, which I couldn't have afford otherwise. Big thanks goes to them. Their platform
allows you to test your website remotely with real devices running Android, iOS, Windows, OS X and even Windows Phone, just in your browser. There is a 30 minute trial for new users. I would recommend
using that to see if your website runs nicely on all platforms.
