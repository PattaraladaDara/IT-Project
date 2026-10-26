# Deploy QueueFlow บน Hostinger KVM 1

คู่มือนี้ใช้ Docker Compose เพื่อรันหน้าเว็บ/API, PostgreSQL และ Caddy HTTPS
บน VPS เครื่องเดียวกัน โดย PostgreSQL ไม่ถูกเปิดออกสู่อินเทอร์เน็ต

## กรณี VPS มี KU-MED และ Caddy อยู่แล้ว

สำหรับเครื่องที่มี KU-MED ใช้ port 3000 และ Caddy ใช้ ports 80/443 ให้ใช้
docker-compose.hostinger.yml เพิ่มเติม ระบบจะเปิด QueueFlow เฉพาะที่
127.0.0.1:3001 และไม่เริ่ม Caddy container ตัวที่สอง

คำสั่งเปิดระบบ:

~~~bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.hostinger.yml \
  up -d --build
~~~

เพิ่ม site block นี้ต่อท้าย /etc/caddy/Caddyfile:

~~~caddy
queue.ku-med-test.tech {
    reverse_proxy 127.0.0.1:3001
}
~~~

ตรวจและ reload Caddy:

~~~bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
~~~

## 1. เตรียม Hostinger VPS

1. ใน hPanel ไปที่ VPS → Manage
2. ถ้าเป็น VPS ใหม่ ให้ติดตั้ง Ubuntu 24.04 พร้อม Docker template
3. ใน Firewall อนุญาต TCP ports 22, 80, 443
4. ไม่ต้องเปิด ports 3000 หรือ 5432

การติดตั้ง OS ใหม่จะลบข้อมูลเดิมใน VPS จึงควรทำเฉพาะเครื่องใหม่หรือหลังสำรองข้อมูลแล้ว

## 2. ชี้โดเมน

เพิ่ม DNS record ชนิด A ให้โดเมนหรือ subdomain ชี้ไปที่ IPv4 ของ VPS
ตัวอย่าง queue.example.com จากนั้นรอ DNS อัปเดต

## 3. เข้า VPS

เปิด Web Console ใน Hostinger หรือใช้ PowerShell:

~~~powershell
ssh root@VPS_IP
~~~

ตรวจสอบเครื่องมือ:

~~~bash
docker --version
docker compose version
git --version
~~~

## 4. ดาวน์โหลดโปรเจกต์

~~~bash
git clone https://github.com/PattaraladaDara/IT-Project.git /opt/queueflow
cd /opt/queueflow
~~~

## 5. สร้างค่าลับ

~~~bash
cp .env.production.example .env.production
openssl rand -base64 32
nano .env.production
~~~

นำรหัสที่สร้างได้ไปแทนค่า POSTGRES_PASSWORD และเปลี่ยน DOMAIN เป็นโดเมนจริง
ห้ามส่งหรือ commit ไฟล์ .env.production

## 6. ตรวจ configuration และเปิดระบบ

~~~bash
docker compose --env-file .env.production config
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
~~~

ดู log:

~~~bash
docker compose --env-file .env.production logs --tail=100 app
docker compose --env-file .env.production logs --tail=100 db
docker compose --env-file .env.production logs --tail=100 caddy
~~~

Caddy จะขอใบรับรอง HTTPS ให้อัตโนมัติเมื่อ DNS ชี้ถูกต้องและ ports 80/443 เปิดอยู่

## 7. ตรวจระบบ

เปิด URL ต่อไปนี้:

- https://YOUR_DOMAIN/
- https://YOUR_DOMAIN/#/kiosk
- https://YOUR_DOMAIN/#/display
- https://YOUR_DOMAIN/#/login
- https://YOUR_DOMAIN/#/auth/ku-alllogin

ตรวจ API health:

~~~bash
curl -fsS 'https://YOUR_DOMAIN/api?action=health'
~~~

## 8. อัปเดต schema หลังแก้ฐานข้อมูล

Schema จะทำงานอัตโนมัติเฉพาะตอนสร้าง volume PostgreSQL ครั้งแรก หากมีการแก้ schema
ภายหลัง ให้รัน:

~~~bash
cd /opt/queueflow
docker compose --env-file .env.production exec -T db sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/001-queueflow-schema.sql'
~~~

## 9. อัปเดตเว็บไซต์จาก GitHub

~~~bash
cd /opt/queueflow
git pull --ff-only origin main
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
~~~

## 10. สำรองฐานข้อมูล

~~~bash
cd /opt/queueflow
mkdir -p backups
docker compose --env-file .env.production exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "backups/queueflow-$(date +%F-%H%M).sql"
~~~

ควรคัดลอกไฟล์สำรองออกจาก VPS และเปิด Hostinger automatic backups ด้วย

## คำสั่งแก้ปัญหา

~~~bash
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs -f --tail=100
docker compose --env-file .env.production restart app
~~~

หยุดระบบโดยไม่ลบข้อมูล:

~~~bash
docker compose --env-file .env.production down
~~~

อย่าใช้ docker compose down -v เพราะ -v จะลบ volume ฐานข้อมูล
