# Hiển thị lịch sử thay đổi Access Code của room trên tab Classes

**Ngày:** 2026-07-15
**Trạng thái:** Đã duyệt thiết kế, chờ viết plan triển khai

## 1. Mục tiêu

Trong panel chi tiết của mỗi class (tab **Classes**), ngay **dưới** bảng **Room Activity**, hiển thị:

1. **Trạng thái access code hiện tại** của room Greenlight tương ứng (mã Moderator / Viewer đang đặt hay đang trống) + chủ room.
2. **Lịch sử thay đổi access code** — mỗi lần mã bị đặt/đổi/xóa: thời gian, loại mã, giá trị cũ→mới, nguồn (App / Ngoài / Hệ thống), chủ room.

Mục đích: giúp admin thấy **access code đã bị đổi khi nào** (và giá trị cũ→mới, nguồn), phục vụ điều tra.

**Quyết định scope (2026-07-15):** người dùng chỉ cần **thời điểm thay đổi** (`changed_at`), KHÔNG cần đích danh người sửa. Lý do: định danh người bắt buộc phải sửa Greenlight (log Greenlight dạng Lograge không chứa user) — đã loại khỏi phạm vi. Nhờ vậy feature chỉ cần **đọc bảng `access_code_audit` sẵn có**, không đụng Greenlight, không parse log.

## 2. Bối cảnh & ràng buộc

- Access code là tính năng của **Greenlight**, không phải BBB core. Không có trong webhook/BBB API. Chỉ có trong **DB Greenlight** (`greenlight-v3-production`, container `postgres`, postgres:14).
- Dashboard (`bbb-admin-nihaoma`) dùng **DB riêng** (`bbb-admin-nihaoma-postgres`, postgres:16). Cả hai chạy trên cùng server production (112) và chung docker network `greenlight-v3_default`.
- Greenlight **không có audit log sẵn** (không có bảng `versions`/`audits`).
- **Đã triển khai trên production:** một trigger audit `trg_access_code_audit` trên bảng `room_meeting_options` của Greenlight DB, ghi mọi thay đổi 2 access code vào bảng `access_code_audit`. Trigger tra option theo **tên** (`glModeratorAccessCode` / `glViewerAccessCode`) nên portable. Giới hạn: trigger biết giá trị cũ→mới, thời điểm, và ngữ cảnh kết nối DB (`app_name`, `client_addr`) — **không tự biết định danh người dùng Greenlight**.

### Nơi lưu dữ liệu (Greenlight DB)

- `rooms` (id uuid, user_id, name, friendly_id, **meeting_id**, ...)
- `meeting_options` (id, name) — chứa 2 dòng `glModeratorAccessCode`, `glViewerAccessCode` (ID khác nhau giữa các server → **luôn tra theo name**).
- `room_meeting_options` (room_id, meeting_option_id, **value**, created_at, updated_at) — giá trị access code hiện tại (value rỗng = chưa đặt).
- `users` (id, name, email) — chủ room qua `rooms.user_id`.
- `access_code_audit` (op, room_id, option_name, old_value, new_value, changed_at, db_user, app_name, client_addr, backend_pid) — bảng log do trigger ghi.

## 3. Ánh xạ class (dashboard) → room (Greenlight)

Khóa nối là **meeting_id**. Chuỗi ánh xạ:

```
class (dashboard) → dashboard.meetings.meeting_id  ==  greenlight.rooms.meeting_id → rooms.id (room_id) → access_code_audit.room_id
```

- `classDetail.meetings[].meetingId` cung cấp danh sách meeting_id của class.
- Bổ sung `class_id` làm candidate (cho trường hợp fallback khi Greenlight không gửi `meta_classid`, lúc đó dashboard lưu `class_id = external meeting id`).
- Query Greenlight: `rooms.meeting_id = ANY($candidates)`.

**Rủi ro cần verify khi triển khai:** xác nhận `dashboard.meetings.meeting_id` thực sự lưu **external meeting ID** khớp `greenlight.rooms.meeting_id` (bằng cách so 1 mẫu thực tế). Nếu không khớp, xử lý mapping thay thế trước khi hoàn tất.

## 4. Kiến trúc (Phương án A: đọc read-only on-demand)

Khi mở class detail, dashboard query thẳng Greenlight DB (read-only) lấy trạng thái + log tại thời điểm đó. Không sync, không thêm bảng ở DB dashboard. Luôn tươi mới, best-effort (lỗi thì ẩn phần này, không làm hỏng class detail).

### 4.1. Role read-only trong Greenlight DB (bước ops, chạy 1 lần)

Tạo role chỉ-đọc cho dashboard (không dùng superuser `postgres`):

```sql
-- Chạy trên Greenlight DB (container postgres / db greenlight-v3-production)
CREATE ROLE bbb_admin_ro LOGIN PASSWORD '<mật-khẩu-mạnh>';
GRANT CONNECT ON DATABASE "greenlight-v3-production" TO bbb_admin_ro;
GRANT USAGE ON SCHEMA public TO bbb_admin_ro;
GRANT SELECT ON rooms, room_meeting_options, meeting_options, access_code_audit TO bbb_admin_ro;
```

### 4.2. Config & env

- `src/config.js`: thêm `greenlightDatabaseUrl = process.env.GREENLIGHT_DATABASE_URL || ""`.
- `.env.example`: thêm `GREENLIGHT_DATABASE_URL=` (kèm chú thích: connection string tới Greenlight DB bằng role read-only).
- `docker-compose.yml`: thêm biến `GREENLIGHT_DATABASE_URL` cho service `bbb-admin`.

**Kết nối mạng — điểm cần verify khi triển khai:** host `postgres` bị trùng (dashboard dùng `postgres` cho DB riêng của nó). `GREENLIGHT_DATABASE_URL` phải trỏ tới Greenlight DB một cách **không nhập nhằng**. Cần test kết nối từ trong container `bbb-admin-nihaoma`; nếu `postgres` không trỏ đúng, dùng IP container Greenlight postgres hoặc thêm network alias riêng (vd `greenlight-db`). Quyết định cụ thể chốt bằng test kết nối thực tế trong bước triển khai.

### 4.3. Module mới `src/db/greenlight.js`

- Một `pg.Pool` **riêng** cho Greenlight DB, **chỉ khởi tạo khi có `GREENLIGHT_DATABASE_URL`**. Không có URL → tính năng tự tắt, không ảnh hưởng phần còn lại.
- Hàm `getAccessCodeInfo(meetingIds: string[])` trả về:

```js
{
  rooms: [
    {
      roomId, roomName, meetingId,
      current: {
        moderator: { value: string|null, updatedAt: ISO },
        viewer:    { value: string|null, updatedAt: ISO }
      },
      history: [
        { changedAt: ISO, code: "moderator"|"viewer", op: "INSERT"|"UPDATE"|"DELETE",
          oldValue: string|null, newValue: string|null }
      ]
    }
  ]
}
```

- Nếu không map được room nào → `{ rooms: [] }`.
- Scope tối giản (theo quyết định 2026-07-15): chỉ lấy **thời gian + loại mã + cũ→mới**. Không lấy `source`/`owner` (đã loại). `access_code_audit` vẫn giữ đủ `app_name`/`client_addr` ở DB nếu sau này cần.

### 4.4. Nối vào class detail (`server.js` → `handleClassDetail`)

- Sau khi có `classDetail`, gom `meetingIds` từ `classDetail.meetings` (+ `classId`), gọi `getAccessCodeInfo(...)`.
- Gắn `accessCodeInfo` vào JSON response.
- Bọc `try/catch` → lỗi (Greenlight DB không tới được / chưa cấu hình) thì `accessCodeInfo = null`, class detail vẫn trả bình thường.

### 4.5. Frontend (`public/index.html`)

- Hàm mới `accessCodeSection(info)`, render **ngay sau** `activityTable(...)` trong `renderClassDetail()` (hiện ở dòng ~975).
- Bố cục:
  - Header `Access Codes` + tên room.
  - **Mini-bảng "Hiện tại":** Moderator / Viewer → giá trị đang đặt (hoặc badge "chưa đặt") + thời điểm cập nhật.
  - **Bảng "Change Log"** (dùng class `nh-tbl` sẵn có): **Thời gian | Loại mã | Thay đổi (cũ→mới)**. Sắp xếp mới nhất trước.
  - `info` null / `rooms` rỗng → dòng nhẹ "Chưa liên kết được room Greenlight cho class này" (không phải lỗi đỏ).
- Nhiều room/class (hiếm): render lần lượt từng room.

## 5. Bảo mật

- Dashboard dùng role **read-only** `bbb_admin_ro` — không thể ghi/sửa Greenlight DB.
- `GREENLIGHT_DATABASE_URL` (chứa mật khẩu) chỉ nằm trong env/compose của server, không commit vào repo (`.env.example` để trống).
- Giá trị access code hiển thị trên dashboard admin (nội bộ) — chấp nhận theo yêu cầu.

## 6. Kiểm thử (thủ công — repo không có test framework)

1. Cấu hình `GREENLIGHT_DATABASE_URL`, restart container `bbb-admin`.
2. Mở một class có room Greenlight tồn tại → thấy đúng trạng thái access code hiện tại + owner.
3. Trong Greenlight UI, đổi 1 access code của room đó → refresh class detail → xuất hiện 1 dòng log mới đúng `cũ→mới`, `source = greenlight-app`.
4. Class không map được room → hiển thị dòng "chưa liên kết", không lỗi.
5. Tắt `GREENLIGHT_DATABASE_URL` → class detail vẫn hoạt động, phần access code ẩn.

## 7. Ngoài phạm vi (YAGNI)

- Không định danh chính xác **người dùng Greenlight** đã sửa (cần correlate log Greenlight hoặc thêm PaperTrail — việc riêng, xâm lấn code Greenlight).
- Không sync access code vào DB dashboard.
- Không sửa/ghi gì lên Greenlight DB từ dashboard.
- Không backfill lịch sử quá khứ (audit chỉ có từ lúc cài trigger trở đi).

## 8. Rủi ro triển khai cần verify

1. **Mapping meeting_id:** xác nhận `dashboard.meetings.meeting_id == greenlight.rooms.meeting_id` bằng mẫu thực tế.
2. **Kết nối mạng:** giải quyết nhập nhằng host `postgres`; test kết nối read-only từ container `bbb-admin-nihaoma` tới Greenlight DB.
