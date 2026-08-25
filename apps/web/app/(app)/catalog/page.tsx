import Link from "next/link";

import { CatalogControlCenter } from "../../../components/catalog-control-center";

export default function CatalogPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            Catalog operations <span>ECOMMERCE OS CONTROL PLANE</span>
          </p>
          <h1>由平台商品到可發佈草稿，一頁掌握營運狀態。</h1>
          <p className="lede">
            查看 SHOPLINE 商品鏡像、草稿連結、審核進度與阻塞項目，優先處理最接近發佈的商品。
          </p>
        </div>
        <Link className="primary-button" href="/listings/new">
          建立上架草稿 <span>Create draft</span>
        </Link>
      </div>
      <CatalogControlCenter />
    </div>
  );
}
