export function NewProductBlockedPanel() {
  return (
    <div className="intake-form">
      <h2>新商品（已阻擋） New products (blocked)</h2>
      <p>
        真實的 Opak SHOPLINE Bulk Update
        匯出檔沒有商品代碼、完整商品描述或圖片欄位，並以現有商品編號為鍵值，不能用作建立新商品。
        <br />
        The real Opak SHOPLINE Bulk Update export has no product handle, full
        product description, or images column, and is keyed by an existing
        Product ID — it cannot be used to create new products.
      </p>
      <p>
        新商品建立為獨立、另行驗證的流程，本頁面不會提供。
        <br />
        New product creation is a separate, independently-validated flow and is
        not offered from this page.
      </p>
    </div>
  );
}
