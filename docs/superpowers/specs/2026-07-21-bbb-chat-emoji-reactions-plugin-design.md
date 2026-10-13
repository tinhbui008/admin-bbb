# Thiết kế: BBB Chat Emoji Reactions Plugin

- **Ngày:** 2026-07-21
- **Trạng thái:** Đã duyệt thiết kế, sẵn sàng lập kế hoạch triển khai
- **Nền tảng mục tiêu:** BigBlueButton Server 3.0.31 (SDK `bigbluebutton-html-plugin-sdk` 0.0.x, mới nhất `0.0.73`)

## 1. Mục tiêu

Cho phép **mọi người trong phòng họp** (học sinh + giáo viên) thả emoji, và emoji sẽ
**bay từ đáy panel Public Chat lên trên rồi mờ dần** (kiểu Facebook LIVE / TikTok LIVE thả tim),
hiển thị real-time cho tất cả người trong phòng.

Đây là plugin **độc lập**, tách biệt hoàn toàn với thanh Reactions gốc của BBB (đã cấu hình
riêng trong `settings.yml`). Không sửa core BBB, không fork — chỉ nạp plugin qua manifest.

## 2. Phạm vi

### Trong phạm vi (v1)
- Nút emoji riêng trên Actions bar, cạnh thanh Reactions.
- Emoji picker với **bộ emoji unicode đầy đủ** (dùng `emoji-mart`).
- Hiệu ứng emoji bay từ dưới lên + mờ dần, giới hạn trong vùng panel Public Chat.
- Đồng bộ real-time giữa mọi người trong phòng qua Data Channel.
- Chống spam: rate-limit theo người + giới hạn số emoji đồng thời + nút bật/tắt cho giáo viên.

### Ngoài phạm vi (để bản sau nếu cần)
- Sticker ảnh custom / upload hình riêng (chỉ hỗ trợ emoji unicode ở v1).
- Lưu lịch sử emoji / phát lại trong recording.
- Thống kê, phân tích lượt thả emoji.

## 3. Kiến trúc

Plugin là một React component được BBB HTML5 client nạp từ nguồn ngoài, mở rộng UI qua các
extension point chính thức của SDK.

| # | Thành phần | Extension point / Hook | Vai trò |
|---|-----------|------------------------|---------|
| 1 | **Emoji Button** | `ActionsBarItem` (button) | Nút 😊 cạnh Reactions, bấm để mở picker |
| 2 | **Emoji Picker** | UI trong plugin (`emoji-mart`) | Bảng chọn emoji đầy đủ |
| 3 | **Emoji Data Channel** | `useDataChannel` (`pushPermission: "all"`, `NEW_ITEMS`) | Kênh `emoji-reactions`: gửi & nhận sự kiện emoji |
| 4 | **Toggle Data Channel** | `useDataChannel` (`pushPermission: "moderator"`, `LATEST_ITEM`) | Kênh `emoji-enabled`: giáo viên bật/tắt tính năng |
| 5 | **Overlay** | `FloatingWindow` | Cửa sổ trong suốt, `pointer-events: none`, canh vùng chat → vẽ emoji bay + mờ dần (CSS) |

### Payload data channel `emoji-reactions`
```
{
  id: string,        // uuid, để dedup & làm React key
  emoji: string,     // ký tự emoji unicode
  sender: string,    // tên người gửi (hiển thị tùy chọn)
  ts: number         // timestamp ms
}
```

## 4. Luồng dữ liệu

```
Người dùng bấm emoji trong picker
  → kiểm tra rate-limit cục bộ (client)
  → kiểm tra trạng thái emoji-enabled (giáo viên có tắt không)
  → pushEntry() vào data channel "emoji-reactions" (pushPermission: all)
  → BBB broadcast tới mọi client trong phòng
  → useDataChannel(NEW_ITEMS) ở mỗi client nhận entry mới
  → FloatingWindow render 1 phần tử emoji
  → CSS animation: bay từ đáy panel chat lên trên + mờ dần (~2-3s)
  → tự gỡ khỏi DOM sau khi animation kết thúc
```

## 5. Xử lý chống spam

- **Rate-limit cục bộ:** mỗi người tối đa **1 emoji / 0.5 giây** (chặn ở client trước khi push).
- **Giới hạn đồng thời:** tối đa **~30 emoji** bay cùng lúc trên mỗi client; vượt quá thì bỏ qua
  entry mới (hoặc gỡ cái cũ nhất) để bảo vệ hiệu năng.
- **Nút bật/tắt của giáo viên:** moderator push trạng thái vào kênh `emoji-enabled`. Khi tắt,
  client ẩn nút và bỏ qua mọi emoji đến.

## 6. Rủi ro kỹ thuật & cách xử lý

### R1 — Không có extension point overlay chính thức trên vùng chat
SDK **không cung cấp** điểm chèn trực tiếp vào bên trong panel Public Chat. Giải pháp: dùng
`FloatingWindow` trong suốt đặt chồng lên vùng cột chat.

- **Bước prototype bắt buộc (làm trước tiên):** kiểm chứng `FloatingWindow` có thể:
  (a) nền trong suốt, (b) `pointer-events: none` (không chặn thao tác chat bên dưới),
  (c) đặt/định kích thước phủ đúng vùng cột chat.
- **Fallback nếu không canh chính xác được:** cố định overlay ở cạnh/góc phải màn hình
  (vùng gần chat) thay vì bám sát khung chat.

### R2 — Panel chat bị đóng / di chuyển / resize
Vị trí cột chat có thể thay đổi. Xử lý:
- Truy vấn trạng thái UI của client (chat có đang mở không) nếu SDK cho phép.
- Nếu chat đóng → tạm ẩn hiệu ứng hoặc dồn về vùng mặc định.

### R3 — Hiệu năng khi nhiều emoji
Giới hạn số phần tử đồng thời (mục 5) + dùng CSS transform/opacity (GPU-accelerated),
tự gỡ DOM sau animation.

## 7. Kiểm thử

- **Môi trường dev:** plugin dev-server của SDK, trỏ client BBB tới plugin đang chạy local.
- **Broadcast đa người:** mở **2+ tab trình duyệt** cùng vào 1 phòng, xác nhận emoji của tab này
  hiện ở tab kia.
- **Rate-limit:** thả liên tục, xác nhận bị chặn đúng ngưỡng 0.5s.
- **Nút giáo viên:** moderator tắt → viewer không thả được và không thấy emoji.
- **Hiệu năng:** thả dồn dập, xác nhận giới hạn ~30 và không giật.
- **Trạng thái chat:** đóng/mở/resize panel chat, xác nhận overlay xử lý đúng (theo R2).

## 8. Triển khai

1. Build plugin → ra file JS tĩnh.
2. Host file JS (trên chính server BBB dưới thư mục static, hoặc CDN).
3. Khai báo plugin trong **manifest** cấu hình của BBB (danh sách plugins client tải).
4. `sudo bbb-conf --restart` và hard-refresh trình duyệt để nạp plugin.

## 9. Quyết định đã chốt

- Emoji picker dùng **bộ emoji đầy đủ** qua `emoji-mart` (riêng biệt với Reactions gốc).
- **Mọi người** đều thả được (`pushPermission: "all"`).
- Bật **rate-limit + giới hạn đồng thời + nút tắt cho giáo viên**.
- Đi **Hướng A (FloatingWindow overlay trên vùng chat)**, có **bước prototype kiểm chứng trước**,
  fallback về góc màn hình nếu SDK không canh được.

## Nguồn tham khảo

- BigBlueButton Plugins docs — https://docs.bigbluebutton.org/plugins/
- bigbluebutton-html-plugin-sdk (GitHub) — https://github.com/bigbluebutton/bigbluebutton-html-plugin-sdk
- Plugins directory — https://github.com/bigbluebutton/plugins
