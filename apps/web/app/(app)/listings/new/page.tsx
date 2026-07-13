import Link from "next/link";

import { ListingIntakeForm } from "../../../../components/listing-intake-form";

export default function NewListingPage() {
  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb"><Link href="/dashboard">工作台</Link><span aria-hidden="true">/</span><span>建立草稿</span></div>
      <div className="page-header">
        <div>
          <p className="eyebrow">資料匯入 <span>LISTING INTAKE</span></p>
          <h1>建立上架草稿</h1>
          <p className="lede">上傳瓶身圖片與供應商資料，AI 會整理成可核對的商品欄位。</p>
        </div>
        <div className="step-indicator"><span className="step-current">01</span><span>資料</span><span className="step-line" /><span>02</span><span>審核</span><span className="step-line" /><span>03</span><span>交付</span></div>
      </div>
      <ListingIntakeForm />
    </div>
  );
}
