# Nihaoma BBB Admin Dashboard — Tài liệu hướng dẫn sử dụng

> Dành cho: Quản trị viên hệ thống  
> Phiên bản: 1.1  

---

## Mục lục

1. [Hero Stats — Thống kê tổng hợp](#1-hero-stats--thống-kê-tổng-hợp)
2. [Summary Strip — Số liệu tóm tắt](#2-summary-strip--số-liệu-tóm-tắt)
3. [Live Active Rooms — Phòng học đang diễn ra](#3-live-active-rooms--phòng-học-đang-diễn-ra)
4. [Analytics — Biểu đồ phân tích](#4-analytics--biểu-đồ-phân-tích)
5. [Explore — Khám phá dữ liệu](#5-explore--khám-phá-dữ-liệu)
   - 5.1 [Tab Classes — Lớp học](#51-tab-classes--lớp-học)
   - 5.2 [Tab Teachers — Giáo viên](#52-tab-teachers--giáo-viên)
   - 5.3 [Tab Students — Học sinh](#53-tab-students--học-sinh)
6. [Sidebar — Bảng xếp hạng](#6-sidebar--bảng-xếp-hạng)
7. [Dark Mode — Giao diện tối](#7-dark-mode--giao-diện-tối)
8. [Cơ chế cập nhật dữ liệu thời gian thực](#8-cơ-chế-cập-nhật-dữ-liệu-thời-gian-thực)

---

## 1. Hero Stats — Thống kê tổng hợp

Bốn thẻ lớn ngay bên dưới header, hiển thị các chỉ số lũy kế **từ trước đến nay** (toàn bộ lịch sử hệ thống).

| Thẻ | Ý nghĩa | Ghi chú |
|---|---|---|
| **Total Events** | Tổng số sự kiện webhook đã nhận được từ BBB | Bao gồm mọi loại sự kiện: tạo phòng, tham gia, rời khỏi, tin nhắn, v.v. |
| **Meetings Created** | Tổng số phiên họp/buổi học đã được tạo | Mỗi lần giáo viên mở một room BBB sẽ tăng thêm 1 |
| **Participants Joined** | Tổng số lượt tham gia (join) vào phòng học | Cùng một học sinh vào cùng một phòng 3 lần = 3 lượt |
| **Participants Left** | Tổng số lượt rời khỏi (leave) phòng học | Tương tự cách tính với Participants Joined |

> **Lưu ý:** Đây là số liệu tích lũy toàn thời gian, không bị ảnh hưởng bởi bộ lọc ngày ở các tab bên dưới.

---

## 2. Summary Strip — Số liệu tóm tắt

Bốn thẻ nhỏ ngay bên dưới Hero Stats, thể hiện số lượng **đối tượng duy nhất** trong hệ thống.

| Thẻ | Ý nghĩa |
|---|---|
| **Unique Meetings** | Số phiên họp/room duy nhất đã từng tồn tại |
| **Unique Users** | Số học sinh duy nhất đã từng đăng nhập vào hệ thống |
| **Unique Classes** | Số lớp học duy nhất trong hệ thống |
| **Unique Teachers** | Số giáo viên duy nhất đã từng dạy |

> Khác với Hero Stats (đếm số lượt), Summary Strip đếm **số thực thể** — mỗi học sinh, giáo viên, lớp học chỉ được đếm một lần dù hoạt động nhiều lần.

---

## 3. Live Active Rooms — Phòng học đang diễn ra

Section này hiển thị **thời gian thực** các phòng học đang hoạt động trên hệ thống BBB.

### Thông tin hiển thị

Mỗi phòng học đang diễn ra được hiển thị dưới dạng thẻ với viền màu bên trái (mỗi phòng một màu để phân biệt):

| Thông tin | Mô tả |
|---|---|
| **Tên phòng** | Tên buổi học/meeting đang chạy |
| **Nhãn LIVE** | Badge xác nhận phòng đang hoạt động |
| **Số người tham gia** (icon người) | Tổng số attendee hiện tại trong phòng |
| **Số moderator** (icon shield) | Số giáo viên/moderator đang trong phòng |
| **Trạng thái** (icon đồng hồ) | Trạng thái hoạt động của phòng |

### Khi không có phòng nào đang hoạt động

Hiển thị thông báo: *"No active classes — Meetings appear here in real time when they start."*

### Cập nhật tự động

Danh sách phòng được đồng bộ từ BBB API và cập nhật qua SSE. Khi có phòng mới bắt đầu hoặc kết thúc, giao diện tự động cập nhật mà không cần tải lại trang.

---

## 4. Analytics — Biểu đồ phân tích

Section Analytics cung cấp 6 loại biểu đồ, chuyển đổi qua các tab phía trên.

### Tab Activity — Hoạt động theo ngày

**Loại biểu đồ:** Line chart (đường)  
**Dữ liệu:** 7 ngày gần nhất

Biểu đồ gồm 3 đường:
- **Meetings** (đỏ): Số phòng học được tạo mỗi ngày
- **Joins** (xanh lá): Số lượt tham gia mỗi ngày
- **Leaves** (vàng): Số lượt rời phòng mỗi ngày

> Dùng để nhận biết ngày cao điểm, xu hướng hoạt động trong tuần.

---

### Tab Peak Hours — Giờ cao điểm

**Loại biểu đồ:** Bar chart (cột)  
**Dữ liệu:** Phân bố theo 24 giờ trong ngày

Mỗi cột đại diện cho một khung giờ (00:00–23:00), chiều cao thể hiện số lượt join trong khung giờ đó. Cột cao nhất được tô đỏ để dễ nhận biết.

> Dùng để xác định khung giờ học phổ biến, lên kế hoạch tài nguyên server.

---

### Tab Duration — Thời lượng buổi học

**Loại biểu đồ:** Line chart (đường)  
**Dữ liệu:** Thời lượng trung bình các buổi học theo ngày (đơn vị: phút)

> Dùng để theo dõi độ dài trung bình các buổi học, phát hiện buổi học quá ngắn hoặc quá dài bất thường.

---

### Tab Participants — Phân bố người dùng

**Loại biểu đồ:** Doughnut chart  
**Dữ liệu:** Tỷ lệ Giáo viên (Teachers) / Học sinh (Students) trong hệ thống

> Dùng để nắm tổng quan cơ cấu người dùng.

---

### Tab Events — Phân loại sự kiện

**Loại biểu đồ:** Doughnut chart  
**Dữ liệu:** 100 sự kiện webhook gần nhất, phân loại theo:

| Màu | Loại sự kiện |
|---|---|
| Đỏ | Joins — lượt tham gia |
| Xanh dương | Leaves — lượt rời phòng |
| Xanh lá | Messages — tin nhắn chat |
| Vàng | Reactions — phản ứng emoji |
| Tím | Polls — bỏ phiếu |
| Cyan | Hands — giơ tay phát biểu |

> Dùng để hiểu mức độ tương tác của học sinh trong các buổi học.

---

### Tab Workload — Khối lượng công việc giáo viên

**Loại biểu đồ:** Doughnut chart  
**Dữ liệu:** Top 10 giáo viên, mỗi phần thể hiện số lớp họ phụ trách

> Dùng để đánh giá mức độ đóng góp và phân bổ công việc giữa các giáo viên.

---

## 5. Explore — Khám phá dữ liệu

Section Explore là nơi xem chi tiết và tìm kiếm dữ liệu. Gồm 3 tab: **Classes, Teachers, Students**.

Giao diện chia làm 2 vùng:
- **Bên trái (tabContent):** Bảng danh sách
- **Bên phải (detailPanel):** Chi tiết item đang được chọn

---

### 5.1 Tab Classes — Lớp học

#### Bộ lọc tìm kiếm

Nằm phía trên bảng, gồm các ô:

| Ô lọc | Chức năng |
|---|---|
| **Search class...** | Tìm theo tên lớp hoặc class ID (gõ Enter hoặc nhấn Filter) |
| **From** | Ngày bắt đầu lọc (mặc định: ngày hôm nay) |
| **To** | Ngày kết thúc lọc (mặc định: ngày hôm nay) |
| **Nút Filter** | Áp dụng bộ lọc, gọi API để lấy kết quả |
| **Nút Clear filter** | Xóa tất cả điều kiện lọc, quay về danh sách mặc định |
| **Nút Export Excel** | Xuất toàn bộ kết quả hiện tại ra file `.xlsx` |

> **Lưu ý:** Bộ lọc ngày áp dụng theo `ngày tạo lớp` (created_at), không phải ngày diễn ra buổi học.

#### Bảng danh sách lớp

| Cột | Ý nghĩa |
|---|---|
| **Class** | Tên lớp (nhấn để xem chi tiết ở panel bên phải) |
| **Created Date** | Ngày giờ lớp được tạo lần đầu trong hệ thống |
| **Teachers** | Số giáo viên đã dạy lớp này |
| **Students** | Số học sinh đã từng tham gia lớp này |
| **Joins** | Tổng số lượt join vào lớp |
| **Leaves** | Tổng số lượt leave khỏi lớp |
| **Status** | Trạng thái hiện tại của lớp (xem bảng bên dưới) |
| **Last Ended** | Thời điểm meeting cuối cùng kết thúc, hoặc `-` nếu chưa có |
| **Nút Detail** (xanh lá) | Xuất file Excel chi tiết hoạt động của lớp đó |

#### Trạng thái lớp (cột Status)

| Badge | Màu | Ý nghĩa |
|---|---|---|
| **Live** (nhấp nháy) | Xanh lá | Lớp đang có meeting chạy trực tiếp trên BBB |
| **Ended** | Xám | Lớp đã có ít nhất một meeting đã kết thúc và hiện không có meeting nào đang chạy |
| **No meetings** | Xám nhạt | Lớp chưa từng có meeting nào được ghi nhận |

#### Phân trang

Khi kết quả có nhiều hơn 20 lớp, thanh phân trang xuất hiện bên dưới bảng với nút **Prev** / **Next** và thông tin `Page X / Y · Z classes`.

#### Export Excel — Toàn bộ danh sách

Nhấn **Export Excel** trên thanh lọc để xuất tất cả lớp đang hiển thị ra file:  
`classes_YYYY-MM-DD.xlsx`

Gồm các cột: `Class ID, Class Name, Created Date, Teachers, Students, Joins, Leaves`

#### Export Excel — Chi tiết từng lớp

Nhấn nút **Detail** (màu xanh lá) ở cuối mỗi hàng để xuất file chi tiết lớp đó:  
`class_<tên lớp>_YYYY-MM-DD.xlsx`

File gồm 1 sheet **Room Activity** với các cột:

| Cột | Ý nghĩa |
|---|---|
| **Name** | Tên người tham gia |
| **Mod** | Có phải Moderator (giáo viên) không — Yes/No |
| **Score** | Điểm hoạt động tổng hợp (tổng số tương tác) |
| **Talk** | Thời gian phát biểu (nói) |
| **Webcam** | Thời gian bật webcam |
| **Msgs** | Số tin nhắn chat đã gửi |
| **React** | Số phản ứng emoji đã sử dụng |
| **Polls** | Số lần tham gia bỏ phiếu |
| **Hands** | Số lần giơ tay phát biểu |
| **Joined** | Thời điểm vào phòng |
| **Left** | Thời điểm rời phòng |
| **Dur** | Tổng thời gian ở trong phòng |

#### Panel chi tiết lớp (bên phải)

Khi nhấn vào tên một lớp trong bảng, panel bên phải hiển thị:

- **Tên lớp** và số lượt join
- **Metrics:** Teachers, Students, Joins, Leaves
- **Danh sách giáo viên** (kèm số meetings đã dạy)
- **Top Students** (6 học sinh tham gia nhiều nhất)
- **Room Activity table:** Bảng chi tiết hoạt động của từng người tham gia (tương tự nội dung export Excel)

---

### 5.2 Tab Teachers — Giáo viên

#### Bảng danh sách giáo viên

| Cột | Ý nghĩa |
|---|---|
| **Teacher** | ID/Tên giáo viên (nhấn để xem chi tiết) |
| **Classes** | Số lớp giáo viên đã dạy |
| **Teachers** | Số giáo viên cùng dạy trong các lớp đó |
| **Joins** | Tổng số lượt join vào các lớp của giáo viên |
| **Leaves** | Tổng số lượt leave khỏi các lớp |

#### Panel chi tiết giáo viên (bên phải)

- **Avatar** với chữ viết tắt tên
- **Metrics:** Students, Meetings, Joins, Leaves
- **Danh sách lớp** mà giáo viên đã dạy

---

### 5.3 Tab Students — Học sinh

#### Bảng danh sách học sinh

| Cột | Ý nghĩa |
|---|---|
| **Student** | Tên học sinh (nhấn để xem chi tiết) |
| **Classes** | Số lớp học sinh đã tham gia |
| **Teachers** | Số giáo viên học sinh đã học cùng |
| **Joins** | Tổng số lượt join |
| **Leaves** | Tổng số lượt leave |

#### Panel chi tiết học sinh (bên phải)

- **Avatar** với chữ viết tắt tên
- **Metrics:** Classes, Teachers, Joins, Leaves
- **Related Classes:** Danh sách lớp đã tham gia
- **Related Teachers:** Danh sách giáo viên đã học cùng

---

## 6. Sidebar — Bảng xếp hạng

Sidebar cố định bên phải màn hình (sticky), hiển thị top 5 trong 3 bảng xếp hạng.

### Top Classes — Lớp học nổi bật nhất

Xếp theo số lượt **join nhiều nhất**, hiển thị top 5.

| Thông tin | Ý nghĩa |
|---|---|
| Số thứ tự (#1–#5) | Thứ hạng |
| Tên lớp | Tên lớp học |
| Sub-text | Số giáo viên · số học sinh |
| Số bên phải (đỏ) | Tổng số lượt join |

---

### Top Teachers — Giáo viên tích cực nhất

Xếp theo số lượt **join vào lớp của giáo viên đó nhiều nhất**, hiển thị top 5.

| Thông tin | Ý nghĩa |
|---|---|
| Avatar | Chữ viết tắt tên giáo viên |
| Tên giáo viên | ID/Tên |
| Sub-text | Số lớp · số học sinh |
| Số bên phải (vàng) | Tổng số lượt join vào lớp của giáo viên |

---

### Top Students — Học sinh chuyên cần nhất

Xếp theo **số lớp đã tham gia nhiều nhất**, hiển thị top 5.

| Thông tin | Ý nghĩa |
|---|---|
| Avatar | Chữ viết tắt tên học sinh |
| Tên học sinh | Tên hiển thị |
| Sub-text | Số lượt join · số giáo viên đã học cùng |
| Số bên phải (xanh lá) | Số lớp đã tham gia |

---

## 7. Dark Mode — Giao diện tối

Nhấn biểu tượng **mặt trời/mặt trăng** ở góc phải header để chuyển đổi giao diện.

- **Light mode** (mặc định): Nền trắng/hồng nhạt, phù hợp ban ngày
- **Dark mode**: Nền tối, giảm mỏi mắt khi làm việc buổi tối

Lựa chọn được **lưu vào trình duyệt** (localStorage), giữ nguyên khi tải lại trang hoặc đóng/mở trình duyệt.

---

## 8. Cơ chế cập nhật dữ liệu thời gian thực

Dashboard sử dụng **SSE (Server-Sent Events)** để nhận dữ liệu cập nhật liên tục từ server mà không cần tải lại trang.

### Luồng hoạt động

```
1. Trang load  →  Gọi /api/stats  →  Hiển thị dữ liệu ban đầu
2. Kết nối SSE /api/stream  →  Nhận event "stats" khi có thay đổi
3. BBB gửi webhook  →  Backend xử lý  →  Đẩy SSE đến tất cả client đang mở dashboard
4. Dashboard tự động re-render các section bị ảnh hưởng
```

### Dấu hiệu dashboard đang hoạt động bình thường

- Số liệu ở Live Active Rooms phản ánh đúng trạng thái thực tế trên BBB
- Khi có học sinh join/leave, số liệu ở Hero Stats tăng tức thì
- Không cần nhấn F5 để cập nhật

### Xử lý khi mất kết nối

Nếu kết nối SSE bị gián đoạn (mạng chập chờn, server restart), EventSource API của trình duyệt sẽ **tự động kết nối lại** sau vài giây. Dữ liệu sẽ tự đồng bộ lại khi kết nối được khôi phục.

---

## Phụ lục — Bảng thuật ngữ

| Thuật ngữ | Giải thích |
|---|---|
| **BBB** | BigBlueButton — phần mềm hội nghị trực tuyến mã nguồn mở |
| **Webhook** | Cơ chế BBB tự động gửi thông báo đến hệ thống Nihaoma khi có sự kiện |
| **SSE** | Server-Sent Events — giao thức truyền dữ liệu một chiều từ server đến trình duyệt theo thời gian thực |
| **Room / Meeting** | Một phòng học/buổi họp trên BBB |
| **Class** | Một lớp học — đơn vị tổ chức chứa nhiều meetings, giáo viên và học sinh |
| **Moderator** | Người có quyền điều phối phòng học (thường là giáo viên) |
| **Join event** | Sự kiện ghi nhận khi ai đó vào phòng học |
| **Leave event** | Sự kiện ghi nhận khi ai đó rời phòng học |
| **Activity Score** | Điểm tổng hợp mức độ tham gia: cộng tổng số tin nhắn + phản ứng + bỏ phiếu + giơ tay + sự kiện talk/webcam |
