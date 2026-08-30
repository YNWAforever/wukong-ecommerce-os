import Link from "next/link";

import { ListingIntakeTabs } from "../../../../components/listing-intake-tabs";

export default function ListingImportPage() {
  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb">
        <Link href="/dashboard">工作台</Link>
        <span aria-hidden="true">/</span>
        <span>SHOPLINE 匯入</span>
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">
            SHOPLINE 匯入 <span>BULK UPDATE IMPORT</span>
          </p>
          <h1>SHOPLINE 商品目錄匯入</h1>
          <p className="lede">
            匯入最新的 SHOPLINE Bulk Update
            匯出檔，更新現有商品；新商品建立為獨立流程，不在此頁面提供。
          </p>
        </div>
      </div>
      <ListingIntakeTabs />
    </div>
  );
}
